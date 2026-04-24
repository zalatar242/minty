'use strict';

// ---------------------------------------------------------------------------
// Pure parsers for LinkedIn message threads.
//
// Entry points:
//   - normalizeMessage(record, context) — normalize a raw extracted bubble to
//                                         the messages.csv row shape.
//   - parseMessagesFromHtml(htmlString, context)
//                                       — regex replay for unit tests.
//
// CSV columns match sources/linkedin/import.js expectations:
//   CONVERSATION ID, CONVERSATION TITLE, FROM, TO, DATE, SUBJECT, CONTENT,
//   FOLDER, ATTACHMENTS, SENDER PROFILE URL
// ---------------------------------------------------------------------------

const MESSAGES_HEADER = [
    'CONVERSATION ID',
    'CONVERSATION TITLE',
    'FROM',
    'TO',
    'DATE',
    'SUBJECT',
    'CONTENT',
    'FOLDER',
    'ATTACHMENTS',
    'SENDER PROFILE URL',
];

function stripTrailing(s) {
    return (s == null ? '' : String(s)).replace(/\s+$/g, '').replace(/^\s+/, '');
}

// Normalize a single message bubble into a CSV row object.
// `record` — { fromName, senderProfileUrl, timestamp, bodyHtml, hasAttachment, subject }
// `context` — { conversationId, conversationTitle, folder, participants: [name] }
function normalizeMessage(record, context) {
    const r = record || {};
    const c = context || {};
    const from = stripTrailing(r.fromName);
    const participants = Array.isArray(c.participants) ? c.participants : [];
    const to = participants.filter((p) => p && p !== from).join(', ');

    return {
        'CONVERSATION ID': stripTrailing(c.conversationId),
        'CONVERSATION TITLE': stripTrailing(c.conversationTitle),
        'FROM': from,
        'TO': to,
        'DATE': stripTrailing(r.timestamp),
        'SUBJECT': stripTrailing(r.subject || c.subject || ''),
        // Keep HTML — import.js does the strip-to-text pass.
        'CONTENT': r.bodyHtml == null ? '' : String(r.bodyHtml),
        'FOLDER': stripTrailing(c.folder),
        'ATTACHMENTS': r.hasAttachment ? '1' : '',
        'SENDER PROFILE URL': stripTrailing(r.senderProfileUrl),
    };
}

function messageRowsToCsvMatrix(records, contextFor) {
    const rows = [];
    for (const rec of (records || [])) {
        const ctx = typeof contextFor === 'function' ? contextFor(rec) : contextFor;
        const norm = normalizeMessage(rec, ctx);
        rows.push(MESSAGES_HEADER.map((k) => norm[k]));
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Regex HTML replay — test-only.
// ---------------------------------------------------------------------------

function textOf(html) {
    if (!html) return '';
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// Split thread HTML into per-bubble chunks. We anchor on <li> or <div>
// with a message-bubble class/attr. Each chunk spans from the opening tag
// of one bubble to the opening tag of the next. We then extract the
// `<time datetime=...>` within each chunk.
function segmentBubbles(html) {
    if (!html) return [];
    // Match <li ...class="...msg-s-event-listitem..."> or <li data-test-message-bubble>
    // or <div class="...msg-s-event-listitem...">.
    // Match the bubble root only — class must end at the event-listitem base
    // name, not match sub-elements like `msg-s-event-listitem__body`.
    const openRe = /<(li|div)\b[^>]*(?:class="[^"]*(?:msg-s-event-listitem|msg-s-message-list__event)(?:\s|")[^"]*"|data-test-message-bubble)[^>]*>/gi;
    const positions = [];
    let m;
    while ((m = openRe.exec(html)) !== null) {
        positions.push(m.index);
    }
    if (positions.length === 0) {
        // Fallback: segment on <time datetime=...> alone.
        const timeRe = /<time[^>]+datetime="([^"]+)"[^>]*>/gi;
        const tpos = [];
        while ((m = timeRe.exec(html)) !== null) tpos.push({ idx: m.index, ts: m[1] });
        return tpos.map((p, i) => ({
            timestamp: p.ts,
            html: html.slice(p.idx, i + 1 < tpos.length ? tpos[i + 1].idx : html.length),
        }));
    }
    const chunks = [];
    for (let i = 0; i < positions.length; i++) {
        const start = positions[i];
        const end = i + 1 < positions.length ? positions[i + 1] : html.length;
        const chunkHtml = html.slice(start, end);
        const ts = /<time[^>]+datetime="([^"]+)"/i.exec(chunkHtml);
        chunks.push({ timestamp: ts ? ts[1] : '', html: chunkHtml });
    }
    return chunks;
}

function parseMessagesFromHtml(html, context) {
    const out = [];
    const ctx = context || {};
    for (const bubble of segmentBubbles(html)) {
        const senderAnchor = /<a[^>]+href="([^"]*\/in\/[^"?#]+[^"]*)"[^>]*>/i.exec(bubble.html);
        const nameEl = /data-test-message-sender-name[^>]*>([^<]+)</i.exec(bubble.html)
            || /class="[^"]*msg-s-message-group__name[^"]*"[^>]*>([^<]+)</i.exec(bubble.html);
        const bodyEl = /data-test-message-body[^>]*>([\s\S]*?)<\//i.exec(bubble.html)
            || /class="[^"]*msg-s-event-listitem__body[^"]*"[^>]*>([\s\S]*?)<\//i.exec(bubble.html);
        const hasAttach = /data-test-attachment|msg-s-event-listitem__attachment|dms\.licdn\.com/i.test(bubble.html);
        out.push(normalizeMessage(
            {
                fromName: nameEl ? textOf(nameEl[1]) : '',
                senderProfileUrl: senderAnchor ? senderAnchor[1] : '',
                timestamp: bubble.timestamp,
                bodyHtml: bodyEl ? bodyEl[1].trim() : '',
                hasAttachment: hasAttach,
            },
            ctx,
        ));
    }
    return out;
}

module.exports = {
    MESSAGES_HEADER,
    normalizeMessage,
    messageRowsToCsvMatrix,
    parseMessagesFromHtml,
};
