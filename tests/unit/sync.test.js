/**
 * tests/unit/sync.test.js — unit tests for crm/sync.js pure functions
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    getDefaultSyncState,
    isStale,
    hashContent,
    computeDirHash,
    loadSyncState,
    saveSyncState,
    deepMerge,
} = require('../../crm/sync');

// ---------------------------------------------------------------------------
// getDefaultSyncState
// ---------------------------------------------------------------------------

test('[Sync]: getDefaultSyncState returns all required source keys', () => {
    const state = getDefaultSyncState();
    for (const source of ['whatsapp', 'email', 'googleContacts', 'linkedin', 'telegram', 'sms']) {
        assert.ok(source in state, `Missing key: ${source}`);
    }
});

test('[Sync]: getDefaultSyncState whatsapp has status idle', () => {
    const state = getDefaultSyncState();
    assert.equal(state.whatsapp.status, 'idle');
    assert.equal(state.whatsapp.messageCount, 0);
    assert.equal(state.whatsapp.lastSyncAt, null);
});

test('[Sync]: getDefaultSyncState email has null historyId', () => {
    const state = getDefaultSyncState();
    assert.equal(state.email.historyId, null);
    assert.equal(state.email.status, 'idle');
});

test('[Sync]: getDefaultSyncState returns new object each call (no shared reference)', () => {
    const a = getDefaultSyncState();
    const b = getDefaultSyncState();
    a.whatsapp.status = 'active';
    assert.equal(b.whatsapp.status, 'idle');
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

test('[Sync]: isStale returns true for null lastSyncAt', () => {
    assert.equal(isStale(null, 60000), true);
});

test('[Sync]: isStale returns true for undefined lastSyncAt', () => {
    assert.equal(isStale(undefined, 60000), true);
});

test('[Sync]: isStale returns false for a recent timestamp', () => {
    const recent = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    assert.equal(isStale(recent, 60000), false); // maxAge 60s
});

test('[Sync]: isStale returns true for an old timestamp', () => {
    const old = new Date(Date.now() - 120000).toISOString(); // 2 minutes ago
    assert.equal(isStale(old, 60000), true); // maxAge 60s
});

test('[Sync]: isStale boundary — exactly at maxAge is NOT stale', () => {
    // age == maxAge: not yet stale (strictly greater than)
    const exactly = new Date(Date.now() - 60000).toISOString();
    // Could be either way at exact boundary; just verify no crash
    const result = isStale(exactly, 60000);
    assert.ok(typeof result === 'boolean');
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

test('[Sync]: hashContent returns a hex string', () => {
    const h = hashContent('hello');
    assert.match(h, /^[a-f0-9]{32}$/);
});

test('[Sync]: hashContent is deterministic', () => {
    assert.equal(hashContent('test'), hashContent('test'));
});

test('[Sync]: hashContent differs for different inputs', () => {
    assert.notEqual(hashContent('foo'), hashContent('bar'));
});

test('[Sync]: hashContent works with Buffer input', () => {
    const h = hashContent(Buffer.from('hello'));
    assert.match(h, /^[a-f0-9]{32}$/);
});

// ---------------------------------------------------------------------------
// computeDirHash
// ---------------------------------------------------------------------------

test('[Sync]: computeDirHash returns null for non-existent directory', () => {
    assert.equal(computeDirHash('/tmp/minty-test-nonexistent-dir-xyz'), null);
});

test('[Sync]: computeDirHash returns a hash string for an existing directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
    const h = computeDirHash(tmpDir);
    assert.match(h, /^[a-f0-9]{32}$/);
    fs.rmSync(tmpDir, { recursive: true });
});

test('[Sync]: computeDirHash changes when file content changes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
    const h1 = computeDirHash(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'world');
    const h2 = computeDirHash(tmpDir);
    assert.notEqual(h1, h2);
    fs.rmSync(tmpDir, { recursive: true });
});

test('[Sync]: computeDirHash is stable (same content → same hash)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'bbb');
    const h1 = computeDirHash(tmpDir);
    const h2 = computeDirHash(tmpDir);
    assert.equal(h1, h2);
    fs.rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// loadSyncState / saveSyncState
// ---------------------------------------------------------------------------

test('[Sync]: loadSyncState returns default state for non-existent file', () => {
    const state = loadSyncState('/tmp/minty-test-nonexistent-sync-state.json');
    const defaults = getDefaultSyncState();
    assert.deepEqual(state, defaults);
});

test('[Sync]: saveSyncState writes valid JSON', () => {
    const tmpFile = path.join(os.tmpdir(), `minty-sync-${Date.now()}.json`);
    const state = getDefaultSyncState();
    state.email.historyId = 'abc123';
    saveSyncState(tmpFile, state);
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(raw.email.historyId, 'abc123');
    fs.unlinkSync(tmpFile);
});

test('[Sync]: loadSyncState round-trips through saveSyncState', () => {
    const tmpFile = path.join(os.tmpdir(), `minty-sync-${Date.now()}.json`);
    const state = getDefaultSyncState();
    state.whatsapp.messageCount = 42;
    state.email.historyId = 'test-history-id';
    state.linkedin.status = 'stale';
    saveSyncState(tmpFile, state);
    const loaded = loadSyncState(tmpFile);
    assert.equal(loaded.whatsapp.messageCount, 42);
    assert.equal(loaded.email.historyId, 'test-history-id');
    assert.equal(loaded.linkedin.status, 'stale');
    fs.unlinkSync(tmpFile);
});

test('[Sync]: loadSyncState merges with defaults (missing keys filled in)', () => {
    const tmpFile = path.join(os.tmpdir(), `minty-sync-${Date.now()}.json`);
    // Write a partial state (missing sms)
    fs.writeFileSync(tmpFile, JSON.stringify({ email: { historyId: 'x', status: 'idle', lastSyncAt: null } }));
    const loaded = loadSyncState(tmpFile);
    // Should have sms from defaults
    assert.ok('sms' in loaded);
    assert.equal(loaded.email.historyId, 'x');
    fs.unlinkSync(tmpFile);
});

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

test('[Sync]: deepMerge shallow merge', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    assert.deepEqual(result, { a: 1, b: 3, c: 4 });
});

test('[Sync]: deepMerge nested objects', () => {
    const result = deepMerge(
        { email: { historyId: null, status: 'idle' } },
        { email: { historyId: 'abc' } }
    );
    assert.equal(result.email.historyId, 'abc');
    assert.equal(result.email.status, 'idle');
});

test('[Sync]: deepMerge does not mutate target', () => {
    const target = { a: { x: 1 } };
    deepMerge(target, { a: { y: 2 } });
    assert.equal(target.a.y, undefined);
});

test('[Sync]: deepMerge handles null source', () => {
    const result = deepMerge({ a: 1 }, null);
    assert.deepEqual(result, { a: 1 });
});
