'use strict';

// ---------------------------------------------------------------------------
// Unit tests for the pure helpers in sources/linkedin/connect.js.
//
// We deliberately do NOT test the full run() flow — that requires Playwright
// and a real browser. These tests cover:
//   - readSyncState: missing file → {}, empty → {}, parse error → {}, valid
//   - writeSyncState: atomic write round-trip
//   - updateLinkedInState: merges linkedin key, preserves other keys
//   - ensureProfileDir: creates with 0o700, rejects loose perms (0o755)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { Readable, Writable } = require('node:stream');

const {
    readSyncState,
    writeSyncState,
    updateLinkedInState,
    ensureProfileDir,
    classifyLoginUrl,
    run,
} = require('../../sources/linkedin/connect');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
    const dir = path.join(os.tmpdir(), 'minty-linkedin-connect-' + randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_err) {
        // best-effort
    }
}

// On Linux/macOS we can meaningfully test mode bits. On Windows, fs.chmod is
// a no-op, so skip the permission-rejection test there.
const canTestPerms = process.platform !== 'win32';

// ---------------------------------------------------------------------------
// readSyncState
// ---------------------------------------------------------------------------

test('readSyncState: missing file → {}', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'does-not-exist.json');
        assert.deepEqual(readSyncState(p), {});
    } finally {
        cleanup(dir);
    }
});

test('readSyncState: empty file → {}', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        fs.writeFileSync(p, '');
        assert.deepEqual(readSyncState(p), {});
    } finally {
        cleanup(dir);
    }
});

test('readSyncState: whitespace-only file → {}', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        fs.writeFileSync(p, '   \n\t  ');
        assert.deepEqual(readSyncState(p), {});
    } finally {
        cleanup(dir);
    }
});

test('readSyncState: invalid JSON → {}', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        fs.writeFileSync(p, '{ not json');
        assert.deepEqual(readSyncState(p), {});
    } finally {
        cleanup(dir);
    }
});

test('readSyncState: JSON array → {} (must be object)', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        fs.writeFileSync(p, '[1, 2, 3]');
        assert.deepEqual(readSyncState(p), {});
    } finally {
        cleanup(dir);
    }
});

test('readSyncState: valid object round-trips', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        const obj = { linkedin: { status: 'connected' }, whatsapp: { status: 'idle' } };
        fs.writeFileSync(p, JSON.stringify(obj));
        assert.deepEqual(readSyncState(p), obj);
    } finally {
        cleanup(dir);
    }
});

// ---------------------------------------------------------------------------
// writeSyncState
// ---------------------------------------------------------------------------

test('writeSyncState: atomic write round-trip', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        const state = { linkedin: { status: 'connected', mode: 'auto-sync' } };
        writeSyncState(p, state);
        const raw = fs.readFileSync(p, 'utf8');
        // Final newline.
        assert.equal(raw.endsWith('\n'), true);
        // Parses back identically.
        assert.deepEqual(JSON.parse(raw), state);
        // No tmp file left behind.
        assert.equal(fs.existsSync(p + '.tmp'), false);
    } finally {
        cleanup(dir);
    }
});

test('writeSyncState: creates parent dir if missing', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'nested', 'deeper', 'sync-state.json');
        writeSyncState(p, { a: 1 });
        assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 });
    } finally {
        cleanup(dir);
    }
});

test('writeSyncState: overwrites existing file', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        fs.writeFileSync(p, JSON.stringify({ old: true }));
        writeSyncState(p, { fresh: true });
        assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { fresh: true });
    } finally {
        cleanup(dir);
    }
});

// ---------------------------------------------------------------------------
// updateLinkedInState
// ---------------------------------------------------------------------------

test('updateLinkedInState: creates linkedin key on missing file', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        updateLinkedInState(p, { status: 'connected', mode: 'auto-sync' });
        const state = readSyncState(p);
        assert.equal(state.linkedin.status, 'connected');
        assert.equal(state.linkedin.mode, 'auto-sync');
    } finally {
        cleanup(dir);
    }
});

test('updateLinkedInState: preserves other top-level keys', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        writeSyncState(p, {
            whatsapp: { status: 'idle' },
            email: { status: 'idle', historyId: 'abc' },
            linkedin: { status: 'disconnected' },
        });
        updateLinkedInState(p, {
            status: 'connected',
            lastConnectAt: '2026-04-23T12:00:00Z',
        });
        const state = readSyncState(p);
        assert.deepEqual(state.whatsapp, { status: 'idle' });
        assert.deepEqual(state.email, { status: 'idle', historyId: 'abc' });
        assert.equal(state.linkedin.status, 'connected');
        assert.equal(state.linkedin.lastConnectAt, '2026-04-23T12:00:00Z');
    } finally {
        cleanup(dir);
    }
});

test('updateLinkedInState: merges into existing linkedin key', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        writeSyncState(p, {
            linkedin: {
                status: 'connected',
                mode: 'auto-sync',
                lastSync: '2026-04-20T10:00:00Z',
            },
        });
        updateLinkedInState(p, {
            status: 'error',
            lastError: { at: '2026-04-23T12:00:00Z', message: 'boom' },
        });
        const state = readSyncState(p);
        // Updated.
        assert.equal(state.linkedin.status, 'error');
        assert.deepEqual(state.linkedin.lastError, {
            at: '2026-04-23T12:00:00Z',
            message: 'boom',
        });
        // Preserved.
        assert.equal(state.linkedin.mode, 'auto-sync');
        assert.equal(state.linkedin.lastSync, '2026-04-20T10:00:00Z');
    } finally {
        cleanup(dir);
    }
});

test('updateLinkedInState: clears field via explicit null', () => {
    const dir = makeTmpDir();
    try {
        const p = path.join(dir, 'sync-state.json');
        writeSyncState(p, {
            linkedin: {
                status: 'error',
                lastError: { at: 'x', message: 'y' },
            },
        });
        updateLinkedInState(p, { status: 'connected', lastError: null });
        const state = readSyncState(p);
        assert.equal(state.linkedin.status, 'connected');
        assert.equal(state.linkedin.lastError, null);
    } finally {
        cleanup(dir);
    }
});

// ---------------------------------------------------------------------------
// ensureProfileDir
// ---------------------------------------------------------------------------

test('ensureProfileDir: creates missing dir with 0o700', { skip: !canTestPerms }, () => {
    const dir = makeTmpDir();
    try {
        const target = path.join(dir, 'linkedin', 'browser-profile');
        ensureProfileDir(target);
        const st = fs.statSync(target);
        assert.equal((st.mode & 0o777) & 0o077, 0, 'no group/other bits');
    } finally {
        cleanup(dir);
    }
});

test('ensureProfileDir: accepts existing 0o700 dir', { skip: !canTestPerms }, () => {
    const dir = makeTmpDir();
    try {
        const target = path.join(dir, 'bp');
        fs.mkdirSync(target, { mode: 0o700 });
        fs.chmodSync(target, 0o700);
        const returned = ensureProfileDir(target);
        assert.equal(returned, target);
    } finally {
        cleanup(dir);
    }
});

test('ensureProfileDir: rejects 0o755 dir', { skip: !canTestPerms }, () => {
    const dir = makeTmpDir();
    try {
        const target = path.join(dir, 'bp');
        fs.mkdirSync(target, { mode: 0o755 });
        fs.chmodSync(target, 0o755);
        assert.throws(
            () => ensureProfileDir(target),
            (err) => {
                assert.equal(err.code, 'EPERM_TOO_LOOSE');
                assert.match(err.message, /chmod 700/);
                return true;
            }
        );
    } finally {
        cleanup(dir);
    }
});

test('ensureProfileDir: rejects 0o750 (group bits set)', { skip: !canTestPerms }, () => {
    const dir = makeTmpDir();
    try {
        const target = path.join(dir, 'bp');
        fs.mkdirSync(target, { mode: 0o750 });
        fs.chmodSync(target, 0o750);
        assert.throws(
            () => ensureProfileDir(target),
            (err) => err.code === 'EPERM_TOO_LOOSE'
        );
    } finally {
        cleanup(dir);
    }
});

test('ensureProfileDir: missing dir arg throws', () => {
    assert.throws(() => ensureProfileDir(), /dir is required/);
    assert.throws(() => ensureProfileDir(''), /dir is required/);
});

// ---------------------------------------------------------------------------
// classifyLoginUrl — the pure URL classifier used by isLoggedIn /
// isChallengeActive. Exported specifically so we can nail down the
// /in/ vs /login substring-matching invariant without standing up Playwright.
// ---------------------------------------------------------------------------

test('classifyLoginUrl: /feed → loggedIn', () => {
    assert.equal(classifyLoginUrl('https://www.linkedin.com/feed/'), 'loggedIn');
    assert.equal(classifyLoginUrl('https://www.linkedin.com/feed'), 'loggedIn');
});

test('classifyLoginUrl: /mynetwork → loggedIn', () => {
    assert.equal(classifyLoginUrl('https://www.linkedin.com/mynetwork/'), 'loggedIn');
    assert.equal(classifyLoginUrl('https://www.linkedin.com/mynetwork/invite-connect/connections/'), 'loggedIn');
});

test('classifyLoginUrl: /in/ profile page → loggedIn', () => {
    assert.equal(classifyLoginUrl('https://www.linkedin.com/in/sree/'), 'loggedIn');
});

test('classifyLoginUrl: /login → unknown (NOT accidentally matched by /in/)', () => {
    // This is the invariant the reviewer flagged — /login contains 'in' but
    // the successUrlPatterns entry is '/in/' (with trailing slash) so it
    // doesn't match. Test pins the behavior so it can't regress silently.
    assert.equal(classifyLoginUrl('https://www.linkedin.com/login'), 'unknown');
    assert.equal(classifyLoginUrl('https://www.linkedin.com/login?redirect=foo'), 'unknown');
});

test('classifyLoginUrl: /uas/login → unknown', () => {
    assert.equal(classifyLoginUrl('https://www.linkedin.com/uas/login?redirect=foo'), 'unknown');
});

test('classifyLoginUrl: /checkpoint/lg → challenge', () => {
    assert.equal(classifyLoginUrl('https://www.linkedin.com/checkpoint/lg/login-submit'), 'challenge');
    assert.equal(classifyLoginUrl('https://www.linkedin.com/checkpoint/challenge/'), 'challenge');
});

test('classifyLoginUrl: /checkpoint takes priority over /feed (in path)', () => {
    // Unlikely URL but tests the priority rule: challenge detection runs first.
    // If a URL somehow contained both (checkpoint redirecting to feed), we'd
    // want to recognize the challenge state — not declare login complete prematurely.
    assert.equal(
        classifyLoginUrl('https://www.linkedin.com/checkpoint/redirect?target=/feed/'),
        'challenge'
    );
});

test('classifyLoginUrl: null / undefined / empty → unknown (no throw)', () => {
    assert.equal(classifyLoginUrl(null), 'unknown');
    assert.equal(classifyLoginUrl(undefined), 'unknown');
    assert.equal(classifyLoginUrl(''), 'unknown');
    assert.equal(classifyLoginUrl(42), 'unknown');
});

test('classifyLoginUrl: non-LinkedIn hosts → classified by path alone', () => {
    // Substring matching means a foo.com/feed URL would classify as loggedIn.
    // We rely on Playwright only navigating us within linkedin.com, so this is
    // fine in practice — test documents the invariant rather than asserts
    // host-checking.
    assert.equal(classifyLoginUrl('https://foo.com/feed'), 'loggedIn');
});

// ---------------------------------------------------------------------------
// run() — save-only path. Because LINKEDIN_SAVE_CREDS_ONLY=1 exits before the
// Playwright guard, we can end-to-end test run() here without needing the
// browser installed. Feeds email/password/TOTP via a mock stdin, asserts
// return 0 and that the creds file exists on disk with mode 0o600.
// ---------------------------------------------------------------------------

function makeMockStdin(lines) {
    // Each line is fed followed by \n. Readable.from accepts an async iterable.
    return Readable.from(
        (async function* () {
            for (const line of lines) yield line + '\n';
        })()
    );
}

function makeMockWritable() {
    const chunks = [];
    const w = new Writable({
        write(chunk, _enc, cb) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
            cb();
        },
    });
    w.getContents = () => chunks.join('');
    return w;
}

test('run(): LINKEDIN_SAVE_CREDS_ONLY=1 saves creds and exits 0 without Playwright', async () => {
    const dir = makeTmpDir();
    const prevSaveOnly = process.env.LINKEDIN_SAVE_CREDS_ONLY;
    const prevSave = process.env.LINKEDIN_SAVE_CREDS;
    const prevForget = process.env.LINKEDIN_FORGET_CREDS;
    const prevManual = process.env.LINKEDIN_MANUAL;
    const prevAcceptTos = process.env.LINKEDIN_ACCEPT_TOS;
    try {
        process.env.LINKEDIN_SAVE_CREDS_ONLY = '1';
        // Clear the other creds/flow toggles so the test is hermetic even when
        // the outer shell has them set.
        delete process.env.LINKEDIN_SAVE_CREDS;
        delete process.env.LINKEDIN_FORGET_CREDS;
        delete process.env.LINKEDIN_MANUAL;
        delete process.env.LINKEDIN_ACCEPT_TOS;

        const stdin = makeMockStdin([
            'test@example.com',       // email
            'hunter2',                 // password
            '',                        // TOTP blank (skip)
        ]);
        const stdout = makeMockWritable();
        const stderr = makeMockWritable();

        const code = await run({ dataDir: dir, stdin, stdout, stderr });

        assert.equal(code, 0, 'save-only path should return 0');

        const credPath = path.join(dir, 'linkedin', 'credentials.json');
        assert.equal(fs.existsSync(credPath), true, 'credentials.json should exist');

        const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        assert.equal(parsed.email, 'test@example.com');
        assert.equal(parsed.password, 'hunter2');
        assert.equal('totpSecret' in parsed, false, 'blank TOTP → field omitted');

        if (canTestPerms) {
            const st = fs.statSync(credPath);
            assert.equal((st.mode & 0o777) & 0o077, 0, 'creds file must be 0o600 (no group/other)');
        }

        const out = stdout.getContents();
        assert.match(out, /Credentials saved/);
        assert.match(out, /Skipping browser launch/);
    } finally {
        if (prevSaveOnly === undefined) delete process.env.LINKEDIN_SAVE_CREDS_ONLY;
        else process.env.LINKEDIN_SAVE_CREDS_ONLY = prevSaveOnly;
        if (prevSave === undefined) delete process.env.LINKEDIN_SAVE_CREDS;
        else process.env.LINKEDIN_SAVE_CREDS = prevSave;
        if (prevForget === undefined) delete process.env.LINKEDIN_FORGET_CREDS;
        else process.env.LINKEDIN_FORGET_CREDS = prevForget;
        if (prevManual === undefined) delete process.env.LINKEDIN_MANUAL;
        else process.env.LINKEDIN_MANUAL = prevManual;
        if (prevAcceptTos === undefined) delete process.env.LINKEDIN_ACCEPT_TOS;
        else process.env.LINKEDIN_ACCEPT_TOS = prevAcceptTos;
        cleanup(dir);
    }
});

test('run(): LINKEDIN_SAVE_CREDS_ONLY=1 with TOTP preserves secret', async () => {
    const dir = makeTmpDir();
    const prev = process.env.LINKEDIN_SAVE_CREDS_ONLY;
    const prevSave = process.env.LINKEDIN_SAVE_CREDS;
    try {
        process.env.LINKEDIN_SAVE_CREDS_ONLY = '1';
        delete process.env.LINKEDIN_SAVE_CREDS;

        const stdin = makeMockStdin([
            'you@example.com',
            'password123',
            'JBSWY3DPEHPK3PXP', // well-known test TOTP secret
        ]);
        const stdout = makeMockWritable();
        const stderr = makeMockWritable();

        const code = await run({ dataDir: dir, stdin, stdout, stderr });

        assert.equal(code, 0);
        const parsed = JSON.parse(
            fs.readFileSync(path.join(dir, 'linkedin', 'credentials.json'), 'utf8')
        );
        assert.equal(parsed.totpSecret, 'JBSWY3DPEHPK3PXP');
    } finally {
        if (prev === undefined) delete process.env.LINKEDIN_SAVE_CREDS_ONLY;
        else process.env.LINKEDIN_SAVE_CREDS_ONLY = prev;
        if (prevSave === undefined) delete process.env.LINKEDIN_SAVE_CREDS;
        else process.env.LINKEDIN_SAVE_CREDS = prevSave;
        cleanup(dir);
    }
});
