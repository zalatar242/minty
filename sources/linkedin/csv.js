'use strict';

// RFC 4180 CSV escaping for LinkedIn scraped content.
// Scraped DM bodies may contain commas, quotes, newlines, and hostile payloads.

function toCsvRow(cells) {
    return (cells || []).map((c) => {
        const s = (c === null || c === undefined) ? '' : String(c);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',');
}

function toCsvFile(header, rows) {
    const lines = [toCsvRow(header)];
    for (const r of (rows || [])) lines.push(toCsvRow(r));
    return lines.join('\r\n');
}

module.exports = { toCsvRow, toCsvFile };
