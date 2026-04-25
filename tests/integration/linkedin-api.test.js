/**
 * tests/integration/linkedin-api.test.js
 *
 * Integration tests for the three LinkedIn auto-sync API routes:
 *   - GET  /api/linkedin/status
 *   - POST /api/linkedin/sync
 *   - POST /api/linkedin/connect
 *
 * AGENTS.md requires integration tests for every new API route. This file is
 * authored AHEAD of the server.js wiring and has a skeleton → live
 * progression:
 *
 *   Phase A (runnable TODAY): helper-level tests against pure modules —
 *     origin-check.js CSRF guard, sync-state.js round-trip, feature-flag gate
 *     semantics. These exercise the building blocks the endpoints will use.
 *
 *   Phase B (runnable TODAY): env / feature-flag behaviour that does not
 *     require a live HTTP server — we can assert what the gate function
 *     returns when MINTY_LINKEDIN_AUTOSYNC is unset.
 *
 *   Phase C (PENDING — unskip once server.js handlers land): tests that stand
 *     up the real server and hit the live endpoints. Each such test is
 *     annotated with `{ skip: true }` today; search for "TODO: unskip once
 *     server.js handlers land" when you're ready to flip them on.
 *
 * When flipping C tests live, also add this file to `npm run test:integration`
 * — it is INTENTIONALLY kept out of the default `npm test` while the skips
 * dominate the run.
 *
 * Run today:
 *   node --test tests/integration/linkedin-api.test.js
 *
 * Run all integration tests (future):
 *   npm run test:integration
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const originCheck = require('../../sources/linkedin/origin-check.js');
const syncState = require('../../sources/linkedin/sync-state.js');

// ===========================================================================
// Phase A — helper-level coverage (runnable today, no server dependency)
// ===========================================================================

test('[LinkedInAPI/A]: origin-check rejects request with no Origin header (C1 CSRF)', () => {
    // Simulates an attacker-crafted fetch() where no Origin is set and the
    // request lacks Sec-Fetch-Site too — we can't verify same-origin, refuse.
    const req = { headers: { host: 'localhost:3456' }, method: 'POST' };
    const result = originCheck.requireSameOrigin(req);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.reason, 'no-origin-signal');
});

test('[LinkedInAPI/A]: origin-check rejects cross-origin POST even with Sec-Fetch-Site header', () => {
    const req = {
        headers: {
            origin: 'http://evil.example',
            host: 'localhost:3456',
            'sec-fetch-site': 'cross-site',
        },
        method: 'POST',
    };
    const result = originCheck.requireSameOrigin(req);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
});

test('[LinkedInAPI/A]: origin-check accepts same-origin POST (localhost:3456)', () => {
    const req = {
        headers: {
            origin: 'http://localhost:3456',
            host: 'localhost:3456',
        },
        method: 'POST',
    };
    const result = originCheck.requireSameOrigin(req);
    assert.equal(result.ok, true);
});

test('[LinkedInAPI/A]: sync-state happy path (status endpoint payload shape)', () => {
    // Mirrors what GET /api/linkedin/status will read from disk. Verifies the
    // shape the handler will return to the SPA.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-int-'));
    syncState.writeLinkedIn(dir, {
        status: 'connected',
        lastSync: '2026-04-23T10:00:00.000Z',
    });
    const ln = syncState.readLinkedIn(dir);
    assert.equal(ln.status, 'connected');
    assert.equal(ln.lastSync, '2026-04-23T10:00:00.000Z');
    // The full status-endpoint response shape (for the SPA card):
    for (const key of [
        'status',
        'mode',
        'lastConnectAt',
        'lastSync',
        'lastError',
        'progress',
    ]) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(ln, key),
            `expected linkedin state key: ${key}`,
        );
    }
});

// ===========================================================================
// Phase B — feature-flag gate (runnable today, no server dependency)
// ===========================================================================

/**
 * Stand-in for the feature-flag gate that crm/server.js will implement. When
 * server.js lands, it will likely live inside the server file itself or a
 * small `crm/features.js` helper; either way, this test encodes the intended
 * semantics so whoever writes that code has a spec to satisfy.
 */
function linkedInAutoSyncEnabled(env) {
    const e = env || process.env;
    const v = e.MINTY_LINKEDIN_AUTOSYNC;
    return v === '1' || v === 'true';
}

test('[LinkedInAPI/B]: feature flag unset → disabled (server must return 404)', () => {
    const env = {}; // no MINTY_LINKEDIN_AUTOSYNC
    assert.equal(linkedInAutoSyncEnabled(env), false);
});

test('[LinkedInAPI/B]: feature flag "1" → enabled', () => {
    assert.equal(linkedInAutoSyncEnabled({ MINTY_LINKEDIN_AUTOSYNC: '1' }), true);
});

test('[LinkedInAPI/B]: feature flag "0" → disabled', () => {
    assert.equal(linkedInAutoSyncEnabled({ MINTY_LINKEDIN_AUTOSYNC: '0' }), false);
});

test('[LinkedInAPI/B]: feature flag "true" → enabled (case-sensitive per spec)', () => {
    assert.equal(
        linkedInAutoSyncEnabled({ MINTY_LINKEDIN_AUTOSYNC: 'true' }),
        true,
    );
});

// ===========================================================================
// Phase C — live-endpoint tests
// ===========================================================================
// These previously held empty placeholder bodies marked
// `{ skip: 'TODO: unskip once server.js handlers land' }`. The handlers
// (handleLinkedInStatus, handleLinkedInSync, handleLinkedInConnect) are now
// in server.js, but live-server tests need a refactor of server.js to expose
// a test-friendly factory (currently the file binds PORT 3456 at require
// time). Until that refactor lands, real coverage of the endpoints is via
// e2e Playwright suites in tests/e2e/. The placeholders were removed because
// empty test bodies provide no assertion value and were creating misleading
// "skipped" noise in the default run.
