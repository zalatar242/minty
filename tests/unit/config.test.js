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

function unsetAllEnv() {
    delete process.env.MINTY_LINKEDIN_AUTOSYNC;
    delete process.env.MINTY_DEMO;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.APOLLO_API_KEY;
}

test('[Config] returns defaults when no file exists', () => {
    unsetAllEnv();
    const d = mkTemp();
    cfg.invalidate();
    const c = cfg.getConfig(d);
    assert.equal(c.linkedinAutosync, false);
    assert.equal(c.demoMode, false);
    assert.equal(c.google.clientId, '');
    assert.equal(c.google.clientSecret, '');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] reads on-disk config.json', () => {
    unsetAllEnv();
    const d = mkTemp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
        linkedinAutosync: true,
        google: { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' },
    }));
    cfg.invalidate();
    const c = cfg.getConfig(d);
    assert.equal(c.linkedinAutosync, true);
    assert.equal(c.google.clientId, 'abc.apps.googleusercontent.com');
    assert.equal(c.google.clientSecret, 'GOCSPX-secret');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] env vars override on-disk values', () => {
    unsetAllEnv();
    const d = mkTemp();
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ linkedinAutosync: false }));
    process.env.MINTY_LINKEDIN_AUTOSYNC = '1';
    cfg.invalidate();
    const c = cfg.getConfig(d);
    assert.equal(c.linkedinAutosync, true);
    delete process.env.MINTY_LINKEDIN_AUTOSYNC;
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] legacy minty-mode.json sets demoMode when mode=demo', () => {
    unsetAllEnv();
    const d = mkTemp();
    fs.writeFileSync(path.join(d, 'minty-mode.json'), JSON.stringify({ mode: 'demo' }));
    cfg.invalidate();
    const c = cfg.getConfig(d);
    assert.equal(c.demoMode, true);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] updateConfig persists patches and bumps cache', () => {
    unsetAllEnv();
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, { linkedinAutosync: true });
    const c = cfg.getConfig(d);
    assert.equal(c.linkedinAutosync, true);
    const reread = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
    assert.equal(reread.linkedinAutosync, true);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] updateConfig deep-merges nested objects', () => {
    unsetAllEnv();
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, { google: { clientId: 'first-id' } });
    cfg.updateConfig(d, { google: { clientSecret: 'first-secret' } });
    const c = cfg.getConfig(d);
    assert.equal(c.google.clientId, 'first-id');
    assert.equal(c.google.clientSecret, 'first-secret');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] getRedactedConfig masks secrets', () => {
    unsetAllEnv();
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, {
        google: { clientId: 'visible-id', clientSecret: 'GOCSPX-veryLongSecretXYZ9' },
    });
    const r = cfg.getRedactedConfig(d);
    assert.equal(r.google.clientId, 'visible-id');
    assert.equal(r.google.clientSecretSet, true);
    assert.equal(r.google.clientSecretMasked, '••••XYZ9');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] envForces reflects env-var presence', () => {
    unsetAllEnv();
    assert.equal(cfg.envForces('linkedinAutosync'), false);
    process.env.MINTY_LINKEDIN_AUTOSYNC = '1';
    assert.equal(cfg.envForces('linkedinAutosync'), true);
    delete process.env.MINTY_LINKEDIN_AUTOSYNC;
});

test('[Config] helper accessors', () => {
    unsetAllEnv();
    const d = mkTemp();
    cfg.invalidate();
    cfg.updateConfig(d, {
        linkedinAutosync: true,
        google: { clientId: 'g-id', clientSecret: 'g-sec' },
        microsoft: { clientId: 'm-id', clientSecret: 'm-sec' },
        apollo: { apiKey: 'apk' },
    });
    assert.equal(cfg.isLinkedInAutosyncEnabled(d), true);
    assert.deepEqual(cfg.getGoogleClient(d), { id: 'g-id', secret: 'g-sec' });
    assert.deepEqual(cfg.getMicrosoftClient(d), { id: 'm-id', secret: 'm-sec' });
    assert.equal(cfg.getApolloKey(d), 'apk');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] cache returns frozen object (no accidental mutation)', () => {
    unsetAllEnv();
    const d = mkTemp();
    cfg.invalidate();
    const c = cfg.getConfig(d);
    assert.throws(() => { c.linkedinAutosync = true; });
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Config] invalidate forces re-read on next getConfig', () => {
    unsetAllEnv();
    const d = mkTemp();
    cfg.invalidate();
    cfg.getConfig(d); // populate cache
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ linkedinAutosync: true }));
    cfg.invalidate();
    const c = cfg.getConfig(d);
    assert.equal(c.linkedinAutosync, true);
    fs.rmSync(d, { recursive: true, force: true });
});
