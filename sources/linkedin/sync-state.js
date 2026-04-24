/**
 * sources/linkedin/sync-state.js
 *
 * Shared read/write helper for the `linkedin` key inside `data/sync-state.json`.
 *
 * Why this file exists:
 *   - connect.js, fetch.js, and crm/server.js (spawn bookkeeping) all need to
 *     update `state.linkedin` consistently.
 *   - Atomic writes (.tmp + fsync + rename) require care; centralising the
 *     pattern avoids subtle drift between callers.
 *
 * Concurrency note (Phase 1 limitation — documented, not fixed):
 *   read+modify+write has an inherent race. We rely on the invariant that only
 *   ONE of {connect.js, fetch.js} runs at a time — enforced by
 *   sources/linkedin/lock.js which uses fs.openSync(..., 'wx') on the browser
 *   profile lock. server.js endpoints READ state freely; the only writes from
 *   server.js are spawn bookkeeping on /api/linkedin/connect and /sync, which
 *   happen before the child process can write. A truly race-free version would
 *   require a file-level lock around sync-state.json itself — deferred.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LINKEDIN_STATE = Object.freeze({
    status: 'disconnected',
    mode: 'auto-sync',
    lastConnectAt: null,
    lastSync: null,
    lastError: null,
    progress: null,
});

function statePath(dataDir) {
    return path.join(dataDir, 'sync-state.json');
}

/** Returns full sync-state object or {} if missing/unreadable. */
function read(dataDir) {
    const file = statePath(dataDir);
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    } catch (_err) {
        return {};
    }
}

/** Returns state.linkedin or a sane default object. */
function readLinkedIn(dataDir) {
    const state = read(dataDir);
    const ln = state && state.linkedin;
    if (ln && typeof ln === 'object') {
        return Object.assign({}, DEFAULT_LINKEDIN_STATE, ln);
    }
    return Object.assign({}, DEFAULT_LINKEDIN_STATE);
}

/** Atomic .tmp + fsync + rename write. */
function writeAtomic(file, body) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, body);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(tmp, file);
    } catch (err) {
        // Best-effort tmp cleanup on rename failure; re-throw the real error.
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        throw err;
    }
}

/**
 * Shallow-merge `updates` into state.linkedin and persist atomically.
 * Preserves all other top-level keys (whatsapp, gmail, etc.).
 */
function writeLinkedIn(dataDir, updates) {
    const file = statePath(dataDir);
    const state = read(dataDir);
    const prev =
        state.linkedin && typeof state.linkedin === 'object'
            ? state.linkedin
            : {};
    state.linkedin = Object.assign({}, prev, updates || {});
    const body = JSON.stringify(state, null, 2) + '\n';
    writeAtomic(file, body);
    return state.linkedin;
}

/** Convenience: set status, clear lastError on "connected". */
function setStatus(dataDir, status, extras) {
    const merged = Object.assign({ status }, extras || {});
    if (status === 'connected') merged.lastError = null;
    return writeLinkedIn(dataDir, merged);
}

/** Convenience: set scraper progress object. */
function setProgress(dataDir, phase, current, total) {
    return writeLinkedIn(dataDir, {
        progress: { phase, current, total },
    });
}

/** Convenience: record an error (status=error, lastError populated). */
function setError(dataDir, reason, message) {
    return writeLinkedIn(dataDir, {
        status: 'error',
        lastError: {
            at: new Date().toISOString(),
            reason: reason || 'unknown',
            message: message || '',
        },
    });
}

module.exports = {
    DEFAULT_LINKEDIN_STATE,
    read,
    readLinkedIn,
    writeLinkedIn,
    setStatus,
    setProgress,
    setError,
};
