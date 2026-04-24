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

const {
    readSyncState,
    writeSyncState,
    updateLinkedInState,
    ensureProfileDir,
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
