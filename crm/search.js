/**
 * crm/search.js — universal search over the unified interaction timeline.
 *
 * Pure functions, no I/O. The server loads interactions once and calls
 * `searchInteractions()` to execute a query with filters and ranking.
 *
 * Query grammar (very small, deliberately):
 *   - "quoted phrase"             — matches the exact phrase
 *   - unquoted word                — case-insensitive token match
 *   - multiple words               — AND (all must appear somewhere in the body/subject)
 *   - prefix search                — trailing * (e.g. invest*) matches invest, investor, investing…
 *   - -word                        — negation: excludes messages containing the token
 *
 * Filters (passed as `opts`):
 *   - source:        string | string[] — restrict to given sources
 *   - contactId:     string            — restrict to a specific contact (joined at the call site)
 *   - chatId:        string            — restrict to a specific conversation
 *   - since:         ISO date          — only messages with timestamp >= since
 *   - until:         ISO date          — only messages with timestamp < until
 *   - excludeGroups: boolean           — skip WhatsApp group chats (@g.us)
 *   - limit:         number            — default 50
 *
 * Result shape (per hit):
 *   {
 *     source, timestamp, chatId, chatName, from, to,
 *     snippet, matches: [{ start, length }],   // offsets within the snippet
 *     matchCount,  // how many distinct tokens/phrases matched
 *     score,       // recency-weighted score, higher = better
 *     raw: interaction,
 *   }
 */

'use strict';

const ALPHA_NUM = /[a-z0-9]+/gi;
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'are', 'was', 'have', 'has',
    'had', 'but', 'not', 'you', 'your', 'our', 'from', 'they', 'them', 'will',
    'would', 'could', 'should',
]);

/**
 * Tokenize a query string into [{ kind, value, negated }].
 * kind ∈ { 'phrase', 'token', 'prefix' }.
 */
function parseQuery(raw) {
    const out = [];
    if (!raw) return out;
    const s = String(raw).trim();
    const re = /-?"([^"]+)"|(-?\S+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const isQuoted = m[1] !== undefined;
        const negated = m[0].startsWith('-');
        let text = isQuoted ? m[1] : m[2];
        if (!isQuoted && negated) text = text.slice(1);
        if (!text) continue;

        if (isQuoted) {
            out.push({ kind: 'phrase', value: text.toLowerCase(), negated });
        } else if (text.endsWith('*') && text.length > 2) {
            out.push({ kind: 'prefix', value: text.slice(0, -1).toLowerCase(), negated });
        } else {
            out.push({ kind: 'token', value: text.toLowerCase(), negated });
        }
    }
    return out;
}

/**
 * Returns every index where `needle` occurs within `haystack` (case-insensitive).
 */
function findAll(haystack, needle) {
    if (!needle) return [];
    const hl = haystack.toLowerCase();
    const nl = needle.toLowerCase();
    const out = [];
    let i = 0;
    while (i <= hl.length - nl.length) {
        const idx = hl.indexOf(nl, i);
        if (idx === -1) break;
        out.push(idx);
        i = idx + nl.length;
    }
    return out;
}

function findPrefix(haystack, prefix) {
    const out = [];
    const hl = haystack.toLowerCase();
    const re = new RegExp('\\b' + escapeRe(prefix.toLowerCase()) + '\\w*', 'g');
    let m;
    while ((m = re.exec(hl)) !== null) out.push(m.index);
    return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Build the (lazy) search text for an interaction.
 */
function searchText(inter) {
    return [inter.body || '', inter.subject || '', inter.chatName || ''].join(' ');
}

/**
 * Execute a query against a list of interactions. See module doc for opts.
 * Returns { query, results, total }.
 */
function searchInteractions(interactions, query, opts = {}) {
    const clauses = parseQuery(query);
    const positive = clauses.filter(c => !c.negated);
    const negative = clauses.filter(c => c.negated);

    if (positive.length === 0) {
        return { query: query || '', results: [], total: 0 };
    }

    const sources = opts.source
        ? new Set(Array.isArray(opts.source) ? opts.source : [opts.source])
        : null;
    const since = opts.since ? new Date(opts.since).getTime() : null;
    const until = opts.until ? new Date(opts.until).getTime() : null;
    const limit = Math.max(1, Math.min(500, opts.limit || 50));

    const results = [];
    const now = Date.now();

    for (const i of interactions) {
        if (sources && !sources.has(i.source)) continue;
        if (opts.contactId && opts.contactId !== i._contactId) continue;
        if (opts.chatId && opts.chatId !== i.chatId) continue;
        if (opts.excludeGroups !== false && i.chatId && String(i.chatId).endsWith('@g.us')) continue;

        const ts = i.timestamp ? new Date(i.timestamp).getTime() : null;
        if (since != null && (ts == null || ts < since)) continue;
        if (until != null && (ts == null || ts >= until)) continue;

        const text = searchText(i);
        if (!text) continue;

        // Negation filter — if any negated clause matches, skip
        let excluded = false;
        for (const c of negative) {
            if (matches(text, c)) { excluded = true; break; }
        }
        if (excluded) continue;

        // Positive clauses — every one must match (AND)
        const hits = [];
        let ok = true;
        for (const c of positive) {
            const ofs = matchOffsets(text, c);
            if (ofs.length === 0) { ok = false; break; }
            for (const offset of ofs) hits.push({ start: offset, length: c.value.length });
        }
        if (!ok) continue;

        hits.sort((a, b) => a.start - b.start);
        const firstHit = hits[0];

        // Build a snippet centered on the first hit (~120 chars window)
        const START = Math.max(0, firstHit.start - 40);
        const END = Math.min(text.length, firstHit.start + firstHit.length + 80);
        const snippet = (START > 0 ? '…' : '') + text.slice(START, END) + (END < text.length ? '…' : '');
        const snippetOffset = START - (START > 0 ? 1 : 0); // account for ellipsis

        // Remap hit offsets into snippet coordinates
        const snippetHits = hits
            .filter(h => h.start >= START && h.start + h.length <= END)
            .map(h => ({ start: h.start - snippetOffset, length: h.length }));

        // Score: positive clause count (weighted) × recency factor
        const ageDays = ts ? (now - ts) / 86400000 : 365;
        const recency = Math.max(0.05, 1 / (1 + ageDays / 30));
        const score = positive.length * 10 + Math.min(10, hits.length) + recency * 5;

        results.push({
            source: i.source,
            timestamp: i.timestamp,
            chatId: i.chatId || null,
            chatName: i.chatName || null,
            from: i.from || null,
            to: i.to || null,
            contactId: i._contactId || null,
            contactName: i._contactName || null,
            snippet,
            matches: snippetHits,
            matchCount: hits.length,
            score,
        });
    }

    results.sort((a, b) => (b.score - a.score) ||
        ((new Date(b.timestamp || 0).getTime()) - (new Date(a.timestamp || 0).getTime())));

    return { query: query || '', results: results.slice(0, limit), total: results.length };
}

function matches(text, clause) {
    if (clause.kind === 'phrase') return text.toLowerCase().includes(clause.value);
    if (clause.kind === 'prefix') return findPrefix(text, clause.value).length > 0;
    // token: case-insensitive substring match of the full token
    return text.toLowerCase().includes(clause.value);
}

function matchOffsets(text, clause) {
    if (clause.kind === 'phrase' || clause.kind === 'token') return findAll(text, clause.value);
    if (clause.kind === 'prefix') return findPrefix(text, clause.value);
    return [];
}

/**
 * Extract the dominant meaningful tokens from a block of text, for surfacing
 * "topics" or building a cheap topic index. Drops stop-words and rare hapaxes.
 */
function dominantTokens(text, opts = {}) {
    const freq = {};
    const min = opts.min || 2;
    const topN = opts.topN || 10;
    const words = String(text || '').toLowerCase().match(ALPHA_NUM) || [];
    for (const w of words) {
        if (w.length < 4 || STOP_WORDS.has(w)) continue;
        freq[w] = (freq[w] || 0) + 1;
    }
    return Object.entries(freq)
        .filter(([, n]) => n >= min)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([w, n]) => ({ token: w, count: n }));
}

module.exports = {
    parseQuery,
    searchInteractions,
    searchText,
    dominantTokens,
    // exposed for tests
    findAll,
    findPrefix,
    STOP_WORDS,
};
