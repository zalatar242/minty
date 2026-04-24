/**
 * Shape tests for scripts/seed-dev-data.js.
 *
 * The seed script is a dev-only tool, but bad output silently corrupts every
 * downstream feature that reads contacts.json / interactions.json. Lock the
 * output shape for every source so regressions fail loud.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const seed = require('../../scripts/seed-dev-data');

function mkTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-seed-'));
}

test('[Seed] generateContacts yields N contacts with expected fields', () => {
    const contacts = seed.generateContacts(12);
    assert.equal(contacts.length, 12);
    for (const c of contacts) {
        assert.ok(c.fullName && typeof c.fullName === 'string');
        assert.ok(c.slug && /^[a-z0-9-]+$/.test(c.slug));
        assert.ok(c.phone.startsWith('+'));
        assert.ok(c.email.includes('@'));
        assert.ok(c.company && c.title && c.category);
        assert.ok(c.coverage && typeof c.coverage === 'object');
        // At least one source must be active
        assert.ok(Object.values(c.coverage).some(Boolean));
    }
});

test('[Seed] generateContacts is deterministic (seeded PRNG)', () => {
    const a = seed.generateContacts(5).map(c => c.fullName);
    const b = seed.generateContacts(5).map(c => c.fullName);
    assert.deepEqual(a, b, 'same seed should produce same output');
});

test('[Seed] buildWhatsApp writes keyed contact map and chat log', () => {
    const dir = mkTempDir();
    const contacts = seed.generateContacts(10);
    seed.buildWhatsApp(contacts, dir);

    const cMap = JSON.parse(fs.readFileSync(path.join(dir, 'whatsapp/contacts.json'), 'utf8'));
    const chats = JSON.parse(fs.readFileSync(path.join(dir, 'whatsapp/chats.json'), 'utf8'));
    // contacts is a keyed map, not an array (matches real WA exporter)
    assert.ok(!Array.isArray(cMap));
    for (const [id, c] of Object.entries(cMap)) {
        assert.ok(id.endsWith('@c.us') || id.endsWith('@g.us'));
        assert.ok(c.name, `contact ${id} missing name`);
    }
    // chats include at least one non-group chat with a messages array
    const nonGroup = Object.values(chats).find(c => c.meta && !c.meta.isGroup);
    assert.ok(nonGroup);
    assert.ok(Array.isArray(nonGroup.messages));
    for (const m of nonGroup.messages) {
        assert.ok(m.timestamp);
        assert.ok(m.body);
    }

    fs.rmSync(dir, { recursive: true, force: true });
});

test('[Seed] buildLinkedIn writes contacts with profileUrl and messages with participants', () => {
    const dir = mkTempDir();
    const contacts = seed.generateContacts(20);
    seed.buildLinkedIn(contacts, dir);

    const li = JSON.parse(fs.readFileSync(path.join(dir, 'linkedin/contacts.json'), 'utf8'));
    assert.ok(Array.isArray(li));
    for (const c of li) {
        assert.ok(c.name);
        assert.ok(c.profileUrl.startsWith('https://www.linkedin.com/in/'));
        assert.ok(c.company && c.position);
    }
    const msgs = JSON.parse(fs.readFileSync(path.join(dir, 'linkedin/messages.json'), 'utf8'));
    assert.ok(Array.isArray(msgs));
    for (const conv of msgs) {
        assert.ok(Array.isArray(conv.participants));
        assert.ok(conv.messages.length > 0);
    }

    fs.rmSync(dir, { recursive: true, force: true });
});

test('[Seed] buildEmail contacts include email + messages have timestamp', () => {
    const dir = mkTempDir();
    const contacts = seed.generateContacts(15);
    seed.buildEmail(contacts, dir);

    const cs = JSON.parse(fs.readFileSync(path.join(dir, 'email/contacts.json'), 'utf8'));
    for (const c of cs) assert.ok(c.email && c.email.includes('@'));

    const ms = JSON.parse(fs.readFileSync(path.join(dir, 'email/messages.json'), 'utf8'));
    for (const m of ms) {
        assert.ok(m.timestamp && !isNaN(Date.parse(m.timestamp)));
        assert.ok(Array.isArray(m.to));
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

test('[Seed] buildSms threads include phone + directions', () => {
    const dir = mkTempDir();
    const contacts = seed.generateContacts(15);
    // Force some SMS coverage
    contacts.forEach(c => { c.coverage.sms = true; });
    seed.buildSms(contacts, dir);

    const threads = JSON.parse(fs.readFileSync(path.join(dir, 'sms/messages.json'), 'utf8'));
    for (const t of threads) {
        assert.ok(t.phone && t.phone.startsWith('+'));
        assert.ok(Array.isArray(t.messages));
        for (const m of t.messages) {
            assert.ok(['sent', 'received'].includes(m.direction));
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

test('[Seed] prng is deterministic', () => {
    const a = seed.prng(42);
    const b = seed.prng(42);
    for (let i = 0; i < 20; i++) assert.equal(a(), b());
});
