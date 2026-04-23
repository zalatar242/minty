/**
 * LinkedIn sync lock — exclusive-create primitive.
 *
 * Prevents two Playwright processes from opening data/linkedin/browser-profile/
 * concurrently (which corrupts the Chromium profile).
 *
 * Design (per plan H4 / M9):
 *   - acquireLock uses fs.openSync(path, 'wx') — fails atomically with EEXIST
 *     if the file exists. Not a race-prone writeFileSync.
 *   - Lock file content: {"pid": N, "startedAt": "<ISO>"}.
 *   - Stealing a lock is ONLY permitted when the recorded PID is dead
 *     (process.kill(pid, 0) throws ESRCH). Never steal on age alone.
 *   - On process exit (normal, SIGINT, SIGTERM), the lock is unlinked.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // ESRCH = no such process. EPERM = exists but we can't signal it.
        // EPERM means it IS alive (different user) — treat as alive.
        if (err.code === 'EPERM') return true;
        return false;
    }
}

function readLock(lockPath) {
    try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

function isStale(lockPath) {
    const info = readLock(lockPath);
    if (!info) return false;
    return !isPidAlive(info.pid);
}

function writeLockFd(fd, pid) {
    const payload = JSON.stringify({ pid, startedAt: new Date().toISOString() });
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
}

/**
 * Try to acquire the lock atomically. Returns { release, info } on success.
 * Throws on contention (another live process holds it).
 *
 * If the existing lock is stale (PID dead), it is stolen silently.
 */
function acquireLock(lockPath) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    let fd;
    try {
        fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;

        // Lock exists — check staleness.
        if (!isStale(lockPath)) {
            const held = readLock(lockPath);
            const e = new Error(
                `LinkedIn sync already running (pid ${held ? held.pid : '?'}, ` +
                `started ${held ? held.startedAt : '?'}). Wait or delete ${lockPath}.`
            );
            e.code = 'ELOCKED';
            e.held = held;
            throw e;
        }

        // Steal the dead lock.
        fs.unlinkSync(lockPath);
        fd = fs.openSync(lockPath, 'wx');
    }

    const pid = process.pid;
    writeLockFd(fd, pid);
    fs.closeSync(fd);

    const release = () => {
        try {
            const info = readLock(lockPath);
            if (info && info.pid === pid) fs.unlinkSync(lockPath);
        } catch (_) { /* best-effort */ }
    };

    registerAutoRelease(release);

    return { release, info: { pid, path: lockPath } };
}

function registerAutoRelease(release) {
    let released = false;
    const once = () => { if (!released) { released = true; release(); } };
    process.once('exit', once);
    process.once('SIGINT', () => { once(); process.exit(130); });
    process.once('SIGTERM', () => { once(); process.exit(143); });
    process.once('uncaughtException', (e) => { once(); throw e; });
}

module.exports = {
    acquireLock,
    isPidAlive,
    readLock,
    isStale,
};
