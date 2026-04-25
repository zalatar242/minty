/**
 * Tests for crm/config.js — runtime user config with hot-reload.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../../crm/config');

function mkTemp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-config-'));
}

test('[Config] returns defaults when no file exists', () => {
    const d = mkTemp();
    cfg.invalidate();
    const c = cfg.getConfig(d);
    assert.equal(c.linkedinAutosync, false);
    assert.equal(c.demoMode, false);
    assert.equal(c.google.clientId, '');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] updateConfig persists and is read back', () => {
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, { linkedinAutosync: true, google: { clientId: 'abc.apps.googleusercontent.com' } });
    const c = cfg.getConfig(d);
    assert.equal(c.linkedinAutosync, true);
    assert.equal(c.google.clientId, 'abc.apps.googleusercontent.com');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] nested updateConfig merges instead of overwriting', () => {
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, { google: { clientId: 'a' } });
    cfg.updateConfig(d, { google: { clientSecret: 'b' } });
    const c = cfg.getConfig(d);
    assert.equal(c.google.clientId, 'a');
    assert.equal(c.google.clientSecret, 'b');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] env vars override the on-disk file', () => {
    const d = mkTemp();
    cfg.updateConfig(d, { linkedinAutosync: false });
    cfg.invalidate();
    process.env.MINTY_LINKEDIN_AUTOSYNC = '1';
    try {
        const c = cfg.getConfig(d);
        assert.equal(c.linkedinAutosync, true);
    } finally {
        delete process.env.MINTY_LINKEDIN_AUTOSYNC;
        cfg.invalidate();
    }
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] file write uses 0600 perms on POSIX', { skip: process.platform === 'win32' }, () => {
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, { google: { clientSecret: 'shh' } });
    const stat = fs.statSync(cfg.configPath(d));
    assert.equal(stat.mode & 0o777, 0o600);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] getRedactedConfig masks secrets but reports presence', () => {
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, {
        google: { clientId: 'pub-id-1234567890', clientSecret: 'GOCSPX-secretthing' },
        apollo: { apiKey: 'apollo-abc123' },
    });
    const r = cfg.getRedactedConfig(d);
    assert.equal(r.google.clientId, 'pub-id-1234567890');  // not a secret
    assert.equal(r.google.clientSecretSet, true);
    assert.ok(r.google.clientSecretMasked.startsWith('••••'));
    assert.ok(r.google.clientSecretMasked.endsWith('hing'));
    assert.equal(r.apollo.apiKeySet, true);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] hot-reload — second getConfig after updateConfig sees fresh value', () => {
    const d = mkTemp();
    cfg.invalidate();
    assert.equal(cfg.getConfig(d).linkedinAutosync, false);
    cfg.updateConfig(d, { linkedinAutosync: true });
    assert.equal(cfg.getConfig(d).linkedinAutosync, true);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] legacy minty-mode.json is honoured (back-compat)', () => {
    // minty-mode.json lives one level above the data dir
    const root = mkTemp();
    const data = path.join(root, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(root, 'minty-mode.json'),
        JSON.stringify({ linkedinAutosync: true, mode: 'demo' }));
    cfg.invalidate();
    const c = cfg.getConfig(data);
    assert.equal(c.linkedinAutosync, true);
    assert.equal(c.demoMode, true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('[Config] deepMerge preserves nested fields not in patch', () => {
    const merged = cfg.deepMerge({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 3 } });
    assert.deepEqual(merged, { a: 1, nested: { x: 1, y: 3 } });
});

test('[Config] helpers return scoped views', () => {
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, { google: { clientId: 'g.id', clientSecret: 'g.s' } });
    assert.deepEqual(cfg.getGoogleClient(d), { id: 'g.id', secret: 'g.s' });
    assert.equal(cfg.isLinkedInAutosyncEnabled(d), false);
    fs.rmSync(d, { recursive: true, force: true });
});
