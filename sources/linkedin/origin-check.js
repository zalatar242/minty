/**
 * origin-check.js — same-origin / CSRF check helper.
 *
 * Security-critical: prevents a malicious webpage (open in the user's browser)
 * from issuing a POST to Minty's local server and triggering side effects like
 * spawning a Chromium child process via POST /api/linkedin/connect.
 *
 * Minty binds to 127.0.0.1:3456 by default and serves plain HTTP (no TLS).
 * The helper combines two signals:
 *
 *   1. `Origin` header (sent by browsers on all CORS-relevant requests,
 *      including same-origin POSTs with non-simple content types like JSON).
 *   2. `Sec-Fetch-Site` (modern browsers; covers form-submission GET→POST where
 *      the browser sometimes omits Origin for same-origin navigations).
 *
 * If neither is present we refuse — we cannot distinguish the attacker.
 *
 * Lives under sources/linkedin/ for v0.2.x since the LinkedIn auto-sync is the
 * driving feature, but the helper is intentionally generic (see ROADMAP note
 * C1) — a follow-up issue wires it into other mutating endpoints.
 */

'use strict';

function resolveHostPort(options) {
    const opts = options || {};
    const host = opts.host
        || process.env.HOST
        || '127.0.0.1';
    const port = Number(opts.port || process.env.PORT || 3456);
    return { host, port };
}

/**
 * allowedOrigins — returns the array of origin strings the server accepts.
 * Always includes localhost + 127.0.0.1 on the configured port; if the server
 * is bound to a different host (e.g. `0.0.0.0` or a LAN IP) that host's origin
 * is also allowed.
 */
function allowedOrigins(options) {
    const { host, port } = resolveHostPort(options);
    const list = [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
    ];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
        const extra = `http://${host}:${port}`;
        if (!list.includes(extra)) list.push(extra);
    }
    return list;
}

/**
 * requireSameOrigin(req, options) → { ok: true } | { ok: false, reason, status }
 *
 * Pure function — does not touch `res`. Caller is responsible for writing the
 * 403 response (use `sendCsrfRejection`).
 */
function requireSameOrigin(req, options) {
    const headers = (req && req.headers) || {};
    const method = (req && req.method) || '';

    const origin = headers.origin || headers.Origin;
    const secFetchSite = headers['sec-fetch-site'] || headers['Sec-Fetch-Site'];
    const hostHeader = headers.host || headers.Host;

    // POST without Host header is malformed HTTP/1.1 — and no browser will
    // ever send this. Refuse unconditionally.
    if (!hostHeader && (method || '').toUpperCase() === 'POST') {
        return { ok: false, reason: 'missing-host', status: 403 };
    }

    const allowed = allowedOrigins(options);

    if (origin) {
        // Exact match only. Guards against:
        //   - http://evil.com                       (different host)
        //   - http://localhost:3456.evil.com        (suffix attack)
        //   - https://localhost:3456                (wrong scheme — Minty is http)
        //   - http://localhost:9999                 (wrong port)
        if (allowed.includes(origin)) {
            return { ok: true };
        }
        return { ok: false, reason: 'origin-mismatch', status: 403 };
    }

    // No Origin: fall back to Sec-Fetch-Site + Host check.
    if (secFetchSite) {
        if (secFetchSite === 'same-origin') {
            // Verify Host header matches one of our allowed host:port pairs.
            const { host, port } = resolveHostPort(options);
            const validHosts = new Set([
                `localhost:${port}`,
                `127.0.0.1:${port}`,
            ]);
            if (host && host !== 'localhost' && host !== '127.0.0.1') {
                validHosts.add(`${host}:${port}`);
            }
            if (validHosts.has(hostHeader)) {
                return { ok: true };
            }
            return { ok: false, reason: 'host-mismatch', status: 403 };
        }
        // 'cross-site', 'same-site', 'none' — refuse. 'same-site' is NOT
        // same-origin (different port/subdomain counts as same-site).
        return { ok: false, reason: `sec-fetch-site-${secFetchSite}`, status: 403 };
    }

    // Neither Origin nor Sec-Fetch-Site — we cannot verify. Refuse.
    return { ok: false, reason: 'no-origin-signal', status: 403 };
}

/**
 * sendCsrfRejection(res, reason) — writes a 403 JSON response. Caller should
 * return immediately after invoking this.
 */
function sendCsrfRejection(res, reason) {
    const body = JSON.stringify({ error: 'csrf', reason: reason || 'unknown' });
    res.writeHead(403, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

module.exports = {
    requireSameOrigin,
    allowedOrigins,
    sendCsrfRejection,
};
