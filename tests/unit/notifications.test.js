'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const N = require('../../crm/notifications');

function mkTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-notifs-'));
}

test('[Notifications] empty when no file present', () => {
    const d = mkTempDir();
    assert.deepStrictEqual(N.list(d), {});
    assert.strictEqual(N.isPaused(d, 'whatsapp'), false);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Notifications] set + list round-trip with since/updatedAt populated', () => {
    const d = mkTempDir();
    N.set(d, 'whatsapp', { needsReauth: true, pauseSync: true, message: 'reauth pls' });
    const all = N.list(d);
    assert.ok(all.whatsapp);
    assert.strictEqual(all.whatsapp.needsReauth, true);
    assert.strictEqual(all.whatsapp.pauseSync, true);
    assert.strictEqual(all.whatsapp.message, 'reauth pls');
    assert.ok(all.whatsapp.since, 'since auto-populated');
    assert.ok(all.whatsapp.updatedAt, 'updatedAt auto-populated');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Notifications] isPaused honors pauseSync flag', () => {
    const d = mkTempDir();
    N.set(d, 'linkedin', { needsReauth: true, pauseSync: true, message: 'x' });
    N.set(d, 'whatsapp', { needsReauth: true, pauseSync: false, message: 'x' });
    assert.strictEqual(N.isPaused(d, 'linkedin'), true);
    assert.strictEqual(N.isPaused(d, 'whatsapp'), false);
    assert.strictEqual(N.isPaused(d, 'nonexistent'), false);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Notifications] dismiss removes entry', () => {
    const d = mkTempDir();
    N.set(d, 'whatsapp', { needsReauth: true, message: 'x' });
    assert.ok(N.list(d).whatsapp);
    N.dismiss(d, 'whatsapp');
    assert.strictEqual(N.list(d).whatsapp, undefined);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Notifications] set preserves original `since` across updates', async () => {
    const d = mkTempDir();
    N.set(d, 'whatsapp', { needsReauth: true, message: 'first' });
    const since1 = N.list(d).whatsapp.since;
    await new Promise(r => setTimeout(r, 5));
    N.set(d, 'whatsapp', { needsReauth: true, message: 'second' });
    const all = N.list(d);
    assert.strictEqual(all.whatsapp.since, since1, 'since persists across re-set');
    assert.strictEqual(all.whatsapp.message, 'second');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Notifications] handles corrupted notifications.json gracefully', () => {
    const d = mkTempDir();
    fs.writeFileSync(path.join(d, 'notifications.json'), '{not valid json');
    assert.deepStrictEqual(N.list(d), {});
    // Subsequent set still succeeds (overwrites the corrupt file)
    N.set(d, 'whatsapp', { needsReauth: true, message: 'x' });
    assert.ok(N.list(d).whatsapp);
    fs.rmSync(d, { recursive: true, force: true });
});
