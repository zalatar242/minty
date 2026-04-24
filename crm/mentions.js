/**
 * crm/mentions.js — @-mention parsing and backlink index.
 *
 * Lets users `@alex chen` inside any notes field. Parses out the handle,
 * resolves it to a contact, and builds a reverse index so contact X's page
 * can show "mentioned by Y, Z" backlinks.
 *
 * Pure functions, no I/O. The server passes the full contact list in and
 * gets a lookup index back.
 *
 * Grammar:
 *   - @name           — single word handle
 *   - @name1 name2    — up to 3-word handle, greedy longest match wins
 *   - @"full name"    — quoted handle, preserves internal spaces/punctuation
 *   - email@domain    — NOT a mention (must have whitespace/line-start before @)
 */

'use strict';

// Non-capturing anchor: start of line OR whitespace OR punctuation.
// Makes sure foo@example.com doesn't trigger a mention.
//
// Handles are single-word by default. Use @"quoted name" to mention a
// multi-word name literally. In resolveMentions we additionally try pulling
// in the next 1-2 words so "@alex chen" resolves to "Alex Chen" when no
// "alex" contact exists — but the base capture is just one token.
const MENTION_RE = /(^|[\s(\[{,;!?])@(?:"([^"]+)"|([A-Za-z][A-Za-z0-9_'-]{0,40}))/g;

/**
 * Find all @mention candidates in a text blob.
 * Returns [{ raw, handle, start, length }] — where start/length point into the
 * original string (not the surrounding whitespace).
 */
function findMentionCandidates(text) {
    if (!text) return [];
    const results = [];
    const s = String(text);
    let m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(s)) !== null) {
        const prefix = m[1] || '';
        const handle = (m[2] !== undefined ? m[2] : m[3]) || '';
        if (!handle) continue;
        const start = m.index + prefix.length; // start at '@'
        const length = handle.length + 1 + (m[2] !== undefined ? 2 : 0); // @handle (+2 for quotes)
        results.push({ raw: m[0].trim(), handle, start, length });
    }
    return results;
}

/**
 * Resolve a handle to the best-matching contact by name.
 * Match priority:
 *   1. Exact (case-insensitive) full-name match
 *   2. Exact first-name match (if unique)
 *   3. startsWith the full name
 *   4. Substring match (only if uniquely identifiable)
 *
 * Returns { contact, confidence } or null. `contacts` is an array.
 */
function resolveHandle(handle, contacts) {
    if (!handle || !contacts || contacts.length === 0) return null;
    const h = String(handle).trim().toLowerCase();
    if (!h) return null;

    const exactFull = [];
    const exactFirst = [];
    const starts = [];
    const substrings = [];

    for (const c of contacts) {
        if (!c.name) continue;
        const n = c.name.toLowerCase().trim();
        if (n === h) exactFull.push(c);
        const firstTok = n.split(/\s+/)[0];
        if (firstTok === h) exactFirst.push(c);
        if (n.startsWith(h)) starts.push(c);
        if (n.includes(h)) substrings.push(c);
    }

    if (exactFull.length === 1) return { contact: exactFull[0], confidence: 'exact' };
    if (exactFull.length > 1) return { contact: exactFull[0], confidence: 'ambiguous' };
    if (exactFirst.length === 1) return { contact: exactFirst[0], confidence: 'first-name' };
    if (starts.length === 1) return { contact: starts[0], confidence: 'startsWith' };
    // Substring only counts if no conflict
    if (substrings.length === 1) return { contact: substrings[0], confidence: 'substring' };
    return null;
}

/**
 * Find all mentions in a text, resolved to contacts.
 *
 * The regex is greedy (captures up to 3 words after @), but real handles are
 * 1-3 words long. So for each candidate we try the longest prefix first, then
 * fall back word-by-word to find the most specific resolution.
 *
 * Returns [{ handle, contactId, contactName, start, length, confidence }].
 * Unresolved handles are dropped so the UI never shows a dead link.
 */
function resolveMentions(text, contacts) {
    if (!text) return [];
    const candidates = findMentionCandidates(text);
    const out = [];
    for (const c of candidates) {
        // If the first word resolves uniquely, take it. Otherwise try greedier —
        // pull in the next 1-2 words from the surrounding text so "@alex chen"
        // can resolve to "Alex Chen" even though findMentionCandidates stopped
        // at "alex" by default.
        let hit = resolveHandle(c.handle, contacts);
        let actualHandle = c.handle;

        if (!hit || hit.confidence !== 'exact') {
            // Look ahead: grab up to 2 more words after the @handle.
            const afterStart = c.start + c.length;
            const after = text.slice(afterStart);
            const m = after.match(/^(\s+[A-Za-z][A-Za-z0-9_'-]{0,40}){1,2}/);
            if (m) {
                const extra = m[0].replace(/^\s+/, '').split(/\s+/);
                // Try longest first: 1+2 words, then 1+1 word, then just 1
                for (let take = extra.length; take >= 1; take--) {
                    const tryHandle = (c.handle + ' ' + extra.slice(0, take).join(' ')).trim();
                    const r = resolveHandle(tryHandle, contacts);
                    if (r && (r.confidence === 'exact' || (!hit && r.confidence === 'first-name'))) {
                        hit = r;
                        actualHandle = tryHandle;
                        break;
                    }
                }
            }
        }
        if (!hit) continue;
        const length = actualHandle.length + 1; // +1 for '@'
        out.push({
            handle: actualHandle,
            contactId: hit.contact.id,
            contactName: hit.contact.name,
            start: c.start,
            length,
            confidence: hit.confidence,
        });
    }
    return out;
}

/**
 * Build a reverse index: for each contact, which OTHER contacts mention them
 * in their notes.
 *
 * Returns { contactId -> Array<{ fromId, fromName, snippet }> }.
 */
function buildMentionIndex(contacts) {
    const index = {};
    for (const c of contacts) {
        if (!c.notes) continue;
        const mentions = resolveMentions(c.notes, contacts);
        for (const m of mentions) {
            if (m.contactId === c.id) continue; // self-mention, skip
            if (!index[m.contactId]) index[m.contactId] = [];
            index[m.contactId].push({
                fromId: c.id,
                fromName: c.name,
                snippet: snippetAround(c.notes, m.start, m.length),
                confidence: m.confidence,
            });
        }
    }
    return index;
}

function snippetAround(text, start, length) {
    const winBefore = Math.max(0, start - 30);
    const winAfter = Math.min(text.length, start + length + 60);
    const pre = winBefore > 0 ? '…' : '';
    const post = winAfter < text.length ? '…' : '';
    return pre + text.slice(winBefore, winAfter).replace(/\s+/g, ' ').trim() + post;
}

/**
 * Render notes to HTML with @mentions linked. The opener is the caller's
 * choice — we just return HTML with `<a class="mention" data-contact-id="...">`.
 * The caller is responsible for HTML-escaping non-mention text (this function
 * escapes internal fragments safely so whole-text ESC is NOT needed).
 */
function renderNotesHtml(text, contacts, opts = {}) {
    if (!text) return '';
    const mentions = resolveMentions(text, contacts);
    if (mentions.length === 0) return escapeHtml(text);

    mentions.sort((a, b) => a.start - b.start);
    const parts = [];
    let i = 0;
    for (const m of mentions) {
        if (m.start > i) parts.push(escapeHtml(text.slice(i, m.start)));
        parts.push(
            '<a class="mention-link" data-contact-id="' + escapeHtml(m.contactId) + '"' +
            (opts.onClick ? ' onclick="' + opts.onClick + '(&#39;' + escapeHtml(m.contactId) + '&#39;)"' : '') +
            '>@' + escapeHtml(m.contactName || m.handle) + '</a>'
        );
        i = m.start + m.length;
    }
    if (i < text.length) parts.push(escapeHtml(text.slice(i)));
    return parts.join('');
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = {
    findMentionCandidates,
    resolveHandle,
    resolveMentions,
    buildMentionIndex,
    renderNotesHtml,
    escapeHtml,
};
