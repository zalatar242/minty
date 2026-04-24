'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { acquireLock, isPidAlive, readLock, isStale } = require('../../sources/linkedin/lock');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpLockPath() {
    return path.join(os.tmpdir(), 'minty-lock-test-' + randomUUID() + '.lock');
}

function cleanup(p) {
    try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
    // Also try to remove any parent dir we might have created (best-effort, only if empty).
    try { fs.rmdirSync(path.dirname(p)); } catch (_) { /* ignore */ }
}

const HELPER = path.resolve(__dirname, '_helpers', 'lock-child.js');

// A PID that should not exist on any reasonable system. Node/Linux PID max is
// typically 4194304, well below this value.
const DEAD_PID = 999999999;

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

test('isPidAlive: current process pid is alive', () => {
    assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive: 0 is not alive', () => {
    assert.equal(isPidAlive(0), false);
});

test('isPidAlive: negative pid is not alive', () => {
    assert.equal(isPidAlive(-1), false);
});

test('isPidAlive: NaN is not alive', () => {
    assert.equal(isPidAlive(NaN), false);
});

test('isPidAlive: string is not alive', () => {
    assert.equal(isPidAlive('abc'), false);
});

test('isPidAlive: huge unused pid is not alive', () => {
    assert.equal(isPidAlive(DEAD_PID), false);
});

// ---------------------------------------------------------------------------
// readLock
// ---------------------------------------------------------------------------

test('readLock: nonexistent path returns null', () => {
    const p = tmpLockPath();
    assert.equal(readLock(p), null);
});

test('readLock: malformed JSON returns null', () => {
    const p = tmpLockPath();
    try {
        fs.writeFileSync(p, '{not json at all');
        assert.equal(readLock(p), null);
    } finally {
        cleanup(p);
    }
});

test('readLock: JSON with missing pid returns null', () => {
    const p = tmpLockPath();
    try {
        fs.writeFileSync(p, JSON.stringify({ startedAt: new Date().toISOString() }));
        assert.equal(readLock(p), null);
    } finally {
        cleanup(p);
    }
});

test('readLock: JSON with missing startedAt returns null', () => {
    const p = tmpLockPath();
    try {
        fs.writeFileSync(p, JSON.stringify({ pid: 1234 }));
        assert.equal(readLock(p), null);
    } finally {
        cleanup(p);
    }
});

test('readLock: valid lock returns {pid, startedAt}', () => {
    const p = tmpLockPath();
    try {
        const startedAt = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify({ pid: 4242, startedAt }));
        const info = readLock(p);
        assert.ok(info);
        assert.equal(info.pid, 4242);
        assert.equal(info.startedAt, startedAt);
    } finally {
        cleanup(p);
    }
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

test('isStale: nonexistent lock is not stale (no lock to be stale)', () => {
    const p = tmpLockPath();
    assert.equal(isStale(p), false);
});

test('isStale: lock for current process is not stale', () => {
    const p = tmpLockPath();
    try {
        fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        assert.equal(isStale(p), false);
    } finally {
        cleanup(p);
    }
});

test('isStale: lock for PID 1 (init) is not stale on Linux', { skip: process.platform !== 'linux' }, () => {
    const p = tmpLockPath();
    try {
        fs.writeFileSync(p, JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }));
        assert.equal(isStale(p), false);
    } finally {
        cleanup(p);
    }
});

test('isStale: lock for dead PID is stale', () => {
    const p = tmpLockPath();
    try {
        fs.writeFileSync(p, JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }));
        assert.equal(isStale(p), true);
    } finally {
        cleanup(p);
    }
});

// ---------------------------------------------------------------------------
// acquireLock — happy path
// ---------------------------------------------------------------------------

test('acquireLock: acquires on nonexistent path and writes lock file', () => {
    const p = tmpLockPath();
    try {
        const res = acquireLock(p);
        assert.ok(res.release);
        assert.ok(res.info);
        assert.equal(res.info.pid, process.pid);
        assert.ok(fs.existsSync(p));
        const on = readLock(p);
        assert.equal(on.pid, process.pid);
        res.release();
        assert.equal(fs.existsSync(p), false);
    } finally {
        cleanup(p);
    }
});

test('acquireLock: release() removes the lock file', () => {
    const p = tmpLockPath();
    try {
        const { release } = acquireLock(p);
        assert.ok(fs.existsSync(p));
        release();
        assert.equal(fs.existsSync(p), false);
    } finally {
        cleanup(p);
    }
});

test('acquireLock: steals silently when existing lock has dead PID', () => {
    const p = tmpLockPath();
    try {
        fs.writeFileSync(p, JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }));
        const { release, info } = acquireLock(p);
        assert.equal(info.pid, process.pid);
        const on = readLock(p);
        assert.equal(on.pid, process.pid);
        release();
    } finally {
        cleanup(p);
    }
});

test('acquireLock: creates parent directories (mkdir recursive)', () => {
    const base = path.join(os.tmpdir(), 'minty-lock-test-' + randomUUID());
    const p = path.join(base, 'nested', 'deeper', 'dir', 'sync.lock');
    try {
        const { release } = acquireLock(p);
        assert.ok(fs.existsSync(p));
        release();
    } finally {
        try { fs.unlinkSync(p); } catch (_) {}
        try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    }
});

// ---------------------------------------------------------------------------
// acquireLock — contention
// ---------------------------------------------------------------------------

test('acquireLock: throws ELOCKED when live process holds the lock', () => {
    const p = tmpLockPath();
    try {
        const startedAt = new Date().toISOString();
        // Pre-existing lock held by a LIVE pid (ourselves).
        fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt }));

        let err;
        try {
            acquireLock(p);
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'expected acquireLock to throw');
        assert.equal(err.code, 'ELOCKED');
        assert.ok(err.held);
        assert.equal(err.held.pid, process.pid);
        assert.equal(err.held.startedAt, startedAt);

        // Original lock file must be untouched.
        const after = readLock(p);
        assert.ok(after);
        assert.equal(after.pid, process.pid);
        assert.equal(after.startedAt, startedAt);
    } finally {
        cleanup(p);
    }
});

// ---------------------------------------------------------------------------
// Cross-process tests
// ---------------------------------------------------------------------------

function spawnChild(lockPath, mode) {
    const child = spawn(process.execPath, [HELPER, lockPath, mode], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = new Promise((resolve, reject) => {
        let buf = '';
        const onData = (chunk) => {
            buf += chunk.toString();
            if (buf.includes('ACQUIRED')) {
                child.stdout.off('data', onData);
                resolve();
            } else if (buf.includes('FAILED')) {
                child.stdout.off('data', onData);
                reject(new Error('child failed: ' + buf));
            }
        };
        child.stdout.on('data', onData);
        child.once('error', reject);
        child.once('exit', (code) => {
            if (!buf.includes('ACQUIRED')) {
                reject(new Error('child exited (' + code + ') before ACQUIRED; buf=' + buf));
            }
        });
    });
    const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { child, ready, exited };
}

test('cross-process: child holds lock, parent gets ELOCKED, succeeds after child exits', async () => {
    const p = tmpLockPath();
    try {
        const { ready, exited } = spawnChild(p, 'hold');
        await ready;

        // While child holds the lock, parent should see ELOCKED.
        let err;
        try {
            acquireLock(p);
        } catch (e) {
            err = e;
        }
        assert.ok(err, 'parent should not be able to acquire while child holds lock');
        assert.equal(err.code, 'ELOCKED');
        assert.ok(err.held);
        assert.notEqual(err.held.pid, process.pid);

        // Wait for child to release + exit.
        const { code } = await exited;
        assert.equal(code, 0);

        // Now parent should acquire cleanly.
        const { release, info } = acquireLock(p);
        assert.equal(info.pid, process.pid);
        release();
    } finally {
        cleanup(p);
    }
});

test('cross-process: child dies ungracefully, parent steals stale lock', async () => {
    const p = tmpLockPath();
    try {
        const { ready, exited } = spawnChild(p, 'die');
        await ready;

        // Wait for child to die. SIGKILL bypasses exit handlers so the
        // lock file is left behind — which is exactly the scenario we
        // want acquireLock's steal-on-dead-PID path to handle.
        const { signal } = await exited;
        assert.equal(signal, 'SIGKILL');

        // Lock file still exists (child did not release) with a dead PID.
        assert.ok(fs.existsSync(p), 'stale lock file should remain after ungraceful death');

        // Parent steals silently.
        const { release, info } = acquireLock(p);
        assert.equal(info.pid, process.pid);
        const on = readLock(p);
        assert.equal(on.pid, process.pid);
        release();
    } finally {
        cleanup(p);
    }
});
