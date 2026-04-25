/**
 * Tests for sources/_shared/progress.js.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../../sources/_shared/progress');

function mkTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-progress-'));
}

test('[Progress] startProgress creates a file with step=init', () => {
    const d = mkTempDir();
    P.startProgress(d, 'telegram', { message: 'Loading…' });
    const rec = P.readProgress(d, 'telegram');
    assert.ok(rec);
    assert.equal(rec.source, 'telegram');
    assert.equal(rec.step, 'init');
    assert.equal(rec.message, 'Loading…');
    assert.ok(rec.startedAt);
    assert.ok(rec.updatedAt);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] updateProgress merges patch into existing record', () => {
    const d = mkTempDir();
    P.startProgress(d, 'email', { message: 'Hello' });
    P.updateProgress(d, 'email', { step: 'messages', current: 7, total: 100 });
    const rec = P.readProgress(d, 'email');
    assert.equal(rec.step, 'messages');
    assert.equal(rec.current, 7);
    assert.equal(rec.total, 100);
    assert.equal(rec.message, 'Hello'); // unchanged
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] isActive returns false for stale records (killed mid-sync)', () => {
    // Mid-sync record whose updatedAt is older than STALE_AFTER_MS — process died.
    const stale = {
        source: 'whatsapp',
        step: 'messages',
        current: 255,
        total: 736,
        updatedAt: new Date(Date.now() - P.STALE_AFTER_MS - 1000).toISOString(),
    };
    assert.equal(P.isActive(stale), false);
    assert.equal(P.isStale(stale), true);

    const fresh = { ...stale, updatedAt: new Date().toISOString() };
    assert.equal(P.isActive(fresh), true);
    assert.equal(P.isStale(fresh), false);
});

test('[Progress] finishProgress marks step=done; isActive returns false', () => {
    const d = mkTempDir();
    P.startProgress(d, 'sms');
    P.updateProgress(d, 'sms', { current: 50, total: 50 });
    P.finishProgress(d, 'sms', { message: 'Imported 50 messages' });
    const rec = P.readProgress(d, 'sms');
    assert.equal(rec.step, 'done');
    assert.equal(rec.message, 'Imported 50 messages');
    assert.equal(P.isActive(rec), false);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress records error message + optional stack', () => {
    const d = mkTempDir();
    P.startProgress(d, 'linkedin');
    const e = new Error('network down');
    P.failProgress(d, 'linkedin', e);
    const rec = P.readProgress(d, 'linkedin');
    assert.equal(rec.step, 'error');
    assert.equal(rec.error.message, 'network down');
    assert.ok(typeof rec.error.stack === 'string');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] percent clamps and returns null when no total', () => {
    assert.equal(P.percent(null), null);
    assert.equal(P.percent({ total: 0 }), null);
    assert.equal(P.percent({ total: 10, current: 5 }), 50);
    assert.equal(P.percent({ total: 10, current: 15 }), 100);
    assert.equal(P.percent({ total: 10, current: -1 }), 0);
});

test('[Progress] listActive excludes done + error', () => {
    const d = mkTempDir();
    P.startProgress(d, 'whatsapp');
    P.updateProgress(d, 'whatsapp', { current: 3, total: 10 });

    P.startProgress(d, 'email');
    P.finishProgress(d, 'email');

    P.startProgress(d, 'telegram');
    P.failProgress(d, 'telegram', new Error('x'));

    const active = P.listActive(d);
    assert.deepEqual(Object.keys(active).sort(), ['whatsapp']);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] whatsapp writes to both canonical and legacy path (back-compat)', () => {
    const d = mkTempDir();
    P.startProgress(d, 'whatsapp', { step: 'contacts', message: 'x' });
    const legacy = path.join(d, 'whatsapp', '.export-progress.json');
    assert.ok(fs.existsSync(legacy), 'legacy path must keep existing for server.js compatibility');
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    assert.equal(raw.step, 'contacts');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] readProgress returns null when source has no progress', () => {
    const d = mkTempDir();
    assert.equal(P.readProgress(d, 'sms'), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] writes are atomic (no half-written JSON after crash-style rename)', () => {
    const d = mkTempDir();
    P.startProgress(d, 'telegram');
    // Simulate many rapid updates — there should never be a parse error
    for (let i = 0; i < 50; i++) {
        P.updateProgress(d, 'telegram', { current: i, total: 50, message: `msg ${i}` });
        const rec = P.readProgress(d, 'telegram');
        assert.ok(rec);
        assert.equal(rec.current, i);
    }
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] listProgress returns every source that has a record', () => {
    const d = mkTempDir();
    P.startProgress(d, 'whatsapp');
    P.startProgress(d, 'linkedin');
    const all = P.listProgress(d);
    assert.deepEqual(Object.keys(all).sort(), ['linkedin', 'whatsapp']);
    fs.rmSync(d, { recursive: true, force: true });
});
