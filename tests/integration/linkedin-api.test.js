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
// Phase C — live-endpoint tests (PENDING: server wiring not landed yet)
// TODO: unskip once server.js handlers land
// ===========================================================================
//
// The intended pattern when unskipping:
//
//   const { createServer } = require('../../crm/server.js');
//   const server = createServer({ dataDir, env: { MINTY_LINKEDIN_AUTOSYNC: '1' } });
//   const port = await listen(server);
//   const res = await fetch(`http://localhost:${port}/api/linkedin/status`, {
//       headers: { Origin: `http://localhost:${port}` },
//   });
//   assert.equal(res.status, 200);
//   ...
//
// server.js today does not export createServer (or an equivalent
// test-friendly factory). When it does, these tests become live.

test(
    '[LinkedInAPI/C]: GET /api/linkedin/status returns 200 when MINTY_LINKEDIN_AUTOSYNC=1',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: GET /api/linkedin/status returns 404 when MINTY_LINKEDIN_AUTOSYNC is unset (feature-flag gate)',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: GET /api/linkedin/status reflects current sync-state.json payload',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: POST /api/linkedin/sync with valid Origin spawns child and returns 202 Accepted',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: POST /api/linkedin/sync with missing/bad Origin returns 403 (C1 CSRF)',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: POST /api/linkedin/sync while sync already running returns 409 Conflict (lock held)',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: POST /api/linkedin/connect passes same-origin check and spawns headful Chromium',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: POST /api/linkedin/connect with bad Origin returns 403',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: POST /api/linkedin/sync returns 503 when playwright module not loadable',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: status enum transitions disconnected → connecting → connected → syncing → connected (happy path)',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);

test(
    '[LinkedInAPI/C]: POST /api/linkedin/sync returns after child process STARTS, not after it finishes',
    { skip: 'TODO: unskip once server.js handlers land' },
    () => {},
);
