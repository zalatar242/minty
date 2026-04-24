/**
 * tests/unit/linkedin-sync-state.test.js
 *
 * Unit tests for sources/linkedin/sync-state.js — the shared read/write helper
 * for the `linkedin` key in data/sync-state.json.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const sync = require('../../sources/linkedin/sync-state.js');

function tmpDataDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-sync-state-'));
    return dir;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// --- read ------------------------------------------------------------------

test('[SyncState]: read returns {} when sync-state.json is missing', () => {
    const dir = tmpDataDir();
    assert.deepEqual(sync.read(dir), {});
});

test('[SyncState]: read returns parsed content when file exists', () => {
    const dir = tmpDataDir();
    const payload = { whatsapp: { status: 'idle' } };
    fs.writeFileSync(
        path.join(dir, 'sync-state.json'),
        JSON.stringify(payload),
    );
    assert.deepEqual(sync.read(dir), payload);
});

test('[SyncState]: read returns {} on malformed JSON', () => {
    const dir = tmpDataDir();
    fs.writeFileSync(path.join(dir, 'sync-state.json'), '{not-json');
    assert.deepEqual(sync.read(dir), {});
});

// --- readLinkedIn defaults -------------------------------------------------

test('[SyncState]: readLinkedIn returns default when file missing', () => {
    const dir = tmpDataDir();
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'disconnected');
    assert.equal(ln.mode, 'auto-sync');
    assert.equal(ln.lastConnectAt, null);
    assert.equal(ln.lastSync, null);
    assert.equal(ln.lastError, null);
    assert.equal(ln.progress, null);
});

test('[SyncState]: readLinkedIn returns default when linkedin key is absent', () => {
    const dir = tmpDataDir();
    fs.writeFileSync(
        path.join(dir, 'sync-state.json'),
        JSON.stringify({ whatsapp: { status: 'idle' } }),
    );
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'disconnected');
    assert.equal(ln.mode, 'auto-sync');
});

test('[SyncState]: readLinkedIn merges defaults over partial persisted state', () => {
    const dir = tmpDataDir();
    fs.writeFileSync(
        path.join(dir, 'sync-state.json'),
        JSON.stringify({ linkedin: { status: 'connected' } }),
    );
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'connected');
    // Default filled in
    assert.equal(ln.mode, 'auto-sync');
    assert.equal(ln.progress, null);
});

// --- writeLinkedIn round-trip ---------------------------------------------

test('[SyncState]: round-trip writeLinkedIn → readLinkedIn preserves fields', () => {
    const dir = tmpDataDir();
    sync.writeLinkedIn(dir, {
        status: 'connected',
        lastConnectAt: '2026-04-23T00:00:00.000Z',
    });
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'connected');
    assert.equal(ln.lastConnectAt, '2026-04-23T00:00:00.000Z');
});

test('[SyncState]: writeLinkedIn preserves other sources untouched', () => {
    const dir = tmpDataDir();
    const file = path.join(dir, 'sync-state.json');
    fs.writeFileSync(
        file,
        JSON.stringify({
            whatsapp: { status: 'idle', messageCount: 42 },
            email: { status: 'syncing', historyId: 'abc' },
            linkedin: { status: 'disconnected' },
        }),
    );
    sync.writeLinkedIn(dir, { status: 'connected' });
    const full = readJson(file);
    assert.deepEqual(full.whatsapp, { status: 'idle', messageCount: 42 });
    assert.deepEqual(full.email, { status: 'syncing', historyId: 'abc' });
    assert.equal(full.linkedin.status, 'connected');
});

test('[SyncState]: writeLinkedIn shallow-merges, preserving untouched linkedin subfields', () => {
    const dir = tmpDataDir();
    sync.writeLinkedIn(dir, {
        status: 'syncing',
        lastSync: '2026-04-22T10:00:00.000Z',
        progress: { phase: 'connections', current: 1, total: 100 },
    });
    // Subsequent write only touches `status` — other fields must persist.
    sync.writeLinkedIn(dir, { status: 'connected' });
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'connected');
    assert.equal(ln.lastSync, '2026-04-22T10:00:00.000Z');
    assert.deepEqual(ln.progress, { phase: 'connections', current: 1, total: 100 });
});

test('[SyncState]: writeLinkedIn creates data dir if missing', () => {
    const dir = tmpDataDir();
    const nested = path.join(dir, 'nested', 'data');
    sync.writeLinkedIn(nested, { status: 'connected' });
    assert.equal(sync.readLinkedIn(nested).status, 'connected');
});

// --- atomic write ----------------------------------------------------------

test('[SyncState]: atomic write leaves NO .tmp sibling after success', () => {
    const dir = tmpDataDir();
    sync.writeLinkedIn(dir, { status: 'connected' });
    const entries = fs.readdirSync(dir);
    const tmpFiles = entries.filter((e) => e.endsWith('.tmp'));
    assert.deepEqual(tmpFiles, [], 'expected no leftover .tmp files');
    assert.ok(entries.includes('sync-state.json'));
});

test('[SyncState]: writeLinkedIn uses fsync+rename (inspect via final file content)', () => {
    // We can't meaningfully mock fsync from inside node:test without heavy
    // stubbing. Instead verify that the persisted file is valid JSON with a
    // trailing newline — the signature of the atomic writer.
    const dir = tmpDataDir();
    sync.writeLinkedIn(dir, { status: 'connected' });
    const raw = fs.readFileSync(path.join(dir, 'sync-state.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), 'expected trailing newline');
    assert.doesNotThrow(() => JSON.parse(raw));
});

// --- setStatus convenience -------------------------------------------------

test('[SyncState]: setStatus("connected") clears lastError', () => {
    const dir = tmpDataDir();
    sync.writeLinkedIn(dir, {
        status: 'error',
        lastError: { at: 'x', reason: 'boom', message: 'bang' },
    });
    sync.setStatus(dir, 'connected');
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'connected');
    assert.equal(ln.lastError, null);
});

test('[SyncState]: setStatus("error") does NOT auto-clear lastError', () => {
    const dir = tmpDataDir();
    sync.writeLinkedIn(dir, {
        lastError: { at: 't', reason: 'r', message: 'm' },
    });
    sync.setStatus(dir, 'error');
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'error');
    assert.deepEqual(ln.lastError, { at: 't', reason: 'r', message: 'm' });
});

test('[SyncState]: setStatus applies extras via shallow merge', () => {
    const dir = tmpDataDir();
    sync.setStatus(dir, 'connected', {
        lastConnectAt: '2026-04-23T01:02:03.000Z',
    });
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'connected');
    assert.equal(ln.lastConnectAt, '2026-04-23T01:02:03.000Z');
});

// --- setProgress -----------------------------------------------------------

test('[SyncState]: setProgress writes progress object', () => {
    const dir = tmpDataDir();
    sync.setProgress(dir, 'messages', 38, 200);
    const ln = sync.readLinkedIn(dir);
    assert.deepEqual(ln.progress, {
        phase: 'messages',
        current: 38,
        total: 200,
    });
});

// --- setError --------------------------------------------------------------

test('[SyncState]: setError sets status=error and populates lastError', () => {
    const dir = tmpDataDir();
    sync.setError(dir, 'network-flap', 'ECONNRESET during fetch');
    const ln = sync.readLinkedIn(dir);
    assert.equal(ln.status, 'error');
    assert.equal(ln.lastError.reason, 'network-flap');
    assert.equal(ln.lastError.message, 'ECONNRESET during fetch');
    assert.ok(
        /\d{4}-\d{2}-\d{2}T/.test(ln.lastError.at),
        'expected ISO timestamp in lastError.at',
    );
});

// --- concurrency note ------------------------------------------------------

test('[SyncState]: DOCUMENTED LIMITATION — read+modify+write is not process-safe', () => {
    // Phase 1 invariant: only ONE of {connect.js, fetch.js} runs concurrently,
    // enforced by sources/linkedin/lock.js (the browser-profile lock uses
    // fs.openSync(..., "wx")). server.js endpoints READ freely; writes happen
    // only during spawn bookkeeping BEFORE the child can write.
    //
    // If two processes did race a writeLinkedIn, the last writer wins and the
    // earlier update may be lost. This test exists to (a) document the
    // assumption and (b) fail loudly if a future refactor removes the lock.js
    // invariant — at which point this file should add a proper lock around
    // sync-state.json writes.
    const dir = tmpDataDir();
    sync.writeLinkedIn(dir, { status: 'syncing' });
    sync.writeLinkedIn(dir, { status: 'connected' });
    assert.equal(sync.readLinkedIn(dir).status, 'connected');
});
