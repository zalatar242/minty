/**
 * tests/unit/linkedin-origin-check.test.js
 *
 * Unit tests for the CSRF / same-origin helper used by Minty's LinkedIn
 * auto-sync POST endpoints. These tests cover only the pure helper — the
 * integration with server.js is exercised in tests/integration/linkedin-api.test.js.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    requireSameOrigin,
    allowedOrigins,
    sendCsrfRejection,
} = require('../../sources/linkedin/origin-check.js');

// --- helpers ---------------------------------------------------------------

function makeReq(headers, method) {
    return { headers: headers || {}, method: method || 'POST' };
}

function makeRes() {
    const calls = { writeHead: null, end: null, ended: false };
    return {
        writeHead(status, hdrs) { calls.writeHead = { status, hdrs }; },
        end(body) { calls.end = body; calls.ended = true; },
        _calls: calls,
    };
}

// Preserve + restore env between tests that mutate it.
function withEnv(vars, fn) {
    const prev = {};
    for (const k of Object.keys(vars)) {
        prev[k] = process.env[k];
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
    }
    try {
        return fn();
    } finally {
        for (const k of Object.keys(prev)) {
            if (prev[k] === undefined) delete process.env[k];
            else process.env[k] = prev[k];
        }
    }
}

// --- Origin header checks --------------------------------------------------

test('[OriginCheck]: Origin http://localhost:3456 → ok', () => {
    const out = requireSameOrigin(makeReq({
        origin: 'http://localhost:3456',
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, true);
});

test('[OriginCheck]: Origin http://127.0.0.1:3456 → ok', () => {
    const out = requireSameOrigin(makeReq({
        origin: 'http://127.0.0.1:3456',
        host: '127.0.0.1:3456',
    }));
    assert.equal(out.ok, true);
});

test('[OriginCheck]: Origin http://evil.com → reject 403', () => {
    const out = requireSameOrigin(makeReq({
        origin: 'http://evil.com',
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
    assert.equal(out.reason, 'origin-mismatch');
});

test('[OriginCheck]: suffix attack http://localhost:3456.evil.com → reject', () => {
    const out = requireSameOrigin(makeReq({
        origin: 'http://localhost:3456.evil.com',
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
});

test('[OriginCheck]: wrong scheme https://localhost:3456 → reject (Minty is http only)', () => {
    const out = requireSameOrigin(makeReq({
        origin: 'https://localhost:3456',
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
});

test('[OriginCheck]: wrong port http://localhost:9999 → reject', () => {
    const out = requireSameOrigin(makeReq({
        origin: 'http://localhost:9999',
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, false);
});

// --- Sec-Fetch-Site fallback ----------------------------------------------

test('[OriginCheck]: no Origin, Sec-Fetch-Site=same-origin + Host=localhost:3456 → ok', () => {
    const out = requireSameOrigin(makeReq({
        'sec-fetch-site': 'same-origin',
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, true);
});

test('[OriginCheck]: no Origin, Sec-Fetch-Site=cross-site → reject', () => {
    const out = requireSameOrigin(makeReq({
        'sec-fetch-site': 'cross-site',
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
    assert.match(out.reason, /cross-site/);
});

test('[OriginCheck]: no Origin, Sec-Fetch-Site=none → reject', () => {
    // Sec-Fetch-Site: none is set on user-initiated navigations (address bar,
    // bookmarks) — those are safe for GETs but not for POSTs, and besides, the
    // browser would have sent Origin for a same-origin POST with JSON body.
    const out = requireSameOrigin(makeReq({
        'sec-fetch-site': 'none',
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
});

test('[OriginCheck]: no Origin and no Sec-Fetch-Site → reject (cannot verify)', () => {
    const out = requireSameOrigin(makeReq({
        host: 'localhost:3456',
    }));
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
    assert.equal(out.reason, 'no-origin-signal');
});

test('[OriginCheck]: Sec-Fetch-Site=same-origin but Host=evil.com → reject', () => {
    const out = requireSameOrigin(makeReq({
        'sec-fetch-site': 'same-origin',
        host: 'evil.com',
    }));
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
    assert.equal(out.reason, 'host-mismatch');
});

// --- Missing Host ---------------------------------------------------------

test('[OriginCheck]: POST with missing Host header → reject', () => {
    const out = requireSameOrigin(makeReq({
        origin: 'http://localhost:3456',
    }, 'POST'));
    assert.equal(out.ok, false);
    assert.equal(out.status, 403);
    assert.equal(out.reason, 'missing-host');
});

// --- env + options --------------------------------------------------------

test('[OriginCheck]: env HOST=0.0.0.0 PORT=8080 → allowed origins include 0.0.0.0:8080', () => {
    withEnv({ HOST: '0.0.0.0', PORT: '8080' }, () => {
        const origins = allowedOrigins();
        assert.ok(origins.includes('http://0.0.0.0:8080'),
            `expected 0.0.0.0:8080 in ${JSON.stringify(origins)}`);
        assert.ok(origins.includes('http://localhost:8080'));
        assert.ok(origins.includes('http://127.0.0.1:8080'));

        // And the Origin check actually accepts a request from that origin.
        const ok = requireSameOrigin(makeReq({
            origin: 'http://0.0.0.0:8080',
            host: '0.0.0.0:8080',
        }));
        assert.equal(ok.ok, true);
    });
});

test('[OriginCheck]: allowedOrigins({host: 192.168.1.10, port: 3456}) includes host-specific origin', () => {
    const origins = allowedOrigins({ host: '192.168.1.10', port: 3456 });
    assert.ok(origins.includes('http://192.168.1.10:3456'),
        `expected 192.168.1.10:3456 in ${JSON.stringify(origins)}`);
    assert.ok(origins.includes('http://localhost:3456'));
    assert.ok(origins.includes('http://127.0.0.1:3456'));
});

test('[OriginCheck]: allowedOrigins with default host does not duplicate localhost/127.0.0.1', () => {
    const origins = allowedOrigins({ host: 'localhost', port: 3456 });
    const counts = origins.filter(o => o === 'http://localhost:3456').length;
    assert.equal(counts, 1);
});

// --- sendCsrfRejection ----------------------------------------------------

test('[OriginCheck]: sendCsrfRejection writes 403 with JSON body', () => {
    const res = makeRes();
    sendCsrfRejection(res, 'origin-mismatch');
    assert.equal(res._calls.writeHead.status, 403);
    assert.equal(res._calls.writeHead.hdrs['Content-Type'], 'application/json');
    assert.equal(res._calls.ended, true);
    const parsed = JSON.parse(res._calls.end);
    assert.equal(parsed.error, 'csrf');
    assert.equal(parsed.reason, 'origin-mismatch');
});

test('[OriginCheck]: sendCsrfRejection with missing reason falls back to "unknown"', () => {
    const res = makeRes();
    sendCsrfRejection(res);
    const parsed = JSON.parse(res._calls.end);
    assert.equal(parsed.error, 'csrf');
    assert.equal(parsed.reason, 'unknown');
});
