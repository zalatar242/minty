'use strict';

// ---------------------------------------------------------------------------
// Pure parsers for LinkedIn connection cards.
//
// Two entry points:
//   - normalizeConnection(record)         — take a raw object extracted by
//                                           Playwright page.$$eval and
//                                           normalize to the Connections.csv
//                                           row shape.
//   - parseConnectionsFromHtml(htmlString) — best-effort regex parser used by
//                                           unit tests and fixture replay.
//                                           NOT used in the live scrape path.
//
// Zero deps. No Playwright. No filesystem. No network.
// ---------------------------------------------------------------------------

const CONNECTIONS_HEADER = [
    'First Name',
    'Last Name',
    'URL',
    'Email Address',
    'Company',
    'Position',
    'Connected On',
    'Location',
];

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function splitName(fullName) {
    const s = (fullName || '').trim().replace(/\s+/g, ' ');
    if (!s) return { first: '', last: '' };
    const parts = s.split(' ');
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
}

// "Senior Engineer at Acme Corp" → { position: "Senior Engineer", company: "Acme Corp" }
// "Founder & CEO at Foo, Inc." → { position: "Founder & CEO", company: "Foo, Inc." }
// "Independent consultant" → { position: "Independent consultant", company: "" }
function splitOccupation(occupation) {
    const s = (occupation || '').trim().replace(/\s+/g, ' ');
    if (!s) return { position: '', company: '' };
    // Last " at " wins — positions can contain "at" in text but company is the tail.
    const idx = s.lastIndexOf(' at ');
    if (idx === -1) return { position: s, company: '' };
    return {
        position: s.slice(0, idx).trim(),
        company: s.slice(idx + 4).trim(),
    };
}

function cleanProfileUrl(href) {
    if (!href) return '';
    // Strip query string + trailing slash normalization.
    let u = String(href).trim();
    // Relative → absolute.
    if (u.startsWith('/')) u = 'https://www.linkedin.com' + u;
    // Trim trailing query/hash.
    const q = u.indexOf('?');
    if (q !== -1) u = u.slice(0, q);
    const h = u.indexOf('#');
    if (h !== -1) u = u.slice(0, h);
    // Keep the canonical `/in/<slug>/` form (ensure single trailing slash).
    return u.replace(/\/+$/, '') + '/';
}

// Convert a raw record extracted by Playwright into a CSV row object.
// Input shape (loose — any field may be missing):
//   { fullName, profileUrl, occupation, email, connectedOn, position, company }
function normalizeConnection(record) {
    const r = record || {};
    const { first, last } = splitName(r.fullName);
    const { position: posFromOcc, company: coFromOcc } = splitOccupation(r.occupation);
    return {
        'First Name': first,
        'Last Name': last,
        'URL': cleanProfileUrl(r.profileUrl),
        'Email Address': (r.email || '').trim(),
        'Company': (r.company || coFromOcc || '').trim(),
        'Position': (r.position || posFromOcc || '').trim(),
        'Connected On': (r.connectedOn || '').trim(),
        'Location': (r.location || '').trim(),
    };
}

function connectionRowsToCsvMatrix(records) {
    const rows = [];
    for (const rec of (records || [])) {
        const norm = normalizeConnection(rec);
        rows.push(CONNECTIONS_HEADER.map((k) => norm[k]));
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Best-effort regex HTML parser — for unit tests and fixture replay ONLY.
// Expects simple, well-formed HTML with `/in/<slug>` anchors per card.
// ---------------------------------------------------------------------------

// Strip a small set of HTML entities + tags to recover plain text.
function textOf(html) {
    if (!html) return '';
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
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

// Segment the HTML into per-card chunks. We split around each `/in/<slug>/`
// anchor — one anchor per card in the live DOM.
function segmentCards(html) {
    if (!html) return [];
    const anchorRe = /<a[^>]+href="([^"]*\/in\/[^"?#]+[^"]*)"[^>]*>/gi;
    const positions = [];
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
        positions.push({ idx: m.index, href: m[1] });
    }
    if (positions.length === 0) return [];
    const chunks = [];
    for (let i = 0; i < positions.length; i++) {
        const start = positions[i].idx;
        const end = i + 1 < positions.length ? positions[i + 1].idx : html.length;
        chunks.push({ href: positions[i].href, html: html.slice(start, end) });
    }
    // De-dupe by profile href (some cards have multiple anchors to same profile).
    const seen = new Set();
    const dedup = [];
    for (const c of chunks) {
        const key = cleanProfileUrl(c.href);
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(c);
    }
    return dedup;
}

function parseConnectionsFromHtml(html) {
    const out = [];
    for (const card of segmentCards(html)) {
        const plain = textOf(card.html);
        // Name: the visible text of the anchor chunk — usually "Firstname Lastname".
        // Take the first line-ish run of letters before any occupation text.
        // We guess "the text up to ' at ' or end" as occupation if present.
        let fullName = '';
        let occupation = '';
        // Attempt to find structured sub-fields via data-* attributes first.
        const nameAttr = /data-test-connection-name[^>]*>([^<]+)</i.exec(card.html);
        if (nameAttr) fullName = textOf(nameAttr[1]);
        const occAttr = /data-test-connection-occupation[^>]*>([^<]+)</i.exec(card.html);
        if (occAttr) occupation = textOf(occAttr[1]);

        if (!fullName) {
            // Fallback — take the first alphabetic-looking span content.
            const m = /<span[^>]*aria-hidden="true"[^>]*>([^<]+)<\/span>/i.exec(card.html);
            if (m) fullName = textOf(m[1]);
        }
        if (!fullName) {
            // Last resort — first 80 chars of the plain text chunk.
            fullName = plain.split(' at ')[0].split('•')[0].trim().slice(0, 80);
        }
        if (!occupation) {
            // Heuristic: if plain text contains " at ", everything after first
            // occurrence of "at ..." is likely the occupation. Narrow by picking
            // the segment that looks like "<role> at <company>".
            const atRe = /([A-Z][^•\n]{2,80}\s+at\s+[^•\n]{1,80})/.exec(plain);
            if (atRe) occupation = atRe[1].trim();
        }
        out.push(normalizeConnection({
            fullName,
            profileUrl: card.href,
            occupation,
        }));
    }
    return out;
}

module.exports = {
    CONNECTIONS_HEADER,
    splitName,
    splitOccupation,
    cleanProfileUrl,
    normalizeConnection,
    connectionRowsToCsvMatrix,
    parseConnectionsFromHtml,
};
