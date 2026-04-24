/**
 * tests/unit/merge-rosters.test.js — unit tests for loadWhatsAppRosters
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ContactIndex } = require('../../crm/utils');

function setupFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-rosters-'));
    const dataDir = path.join(tmp, 'data');
    const waDir = path.join(dataDir, 'whatsapp');
    const outDir = path.join(dataDir, 'unified');
    fs.mkdirSync(waDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    return { tmp, dataDir, waDir, outDir };
}

function loadRostersWithEnv(dataDir, index, outDir) {
    // loadWhatsAppRosters reads from module-scoped DATA; set env and reload module fresh
    const modulePath = require.resolve('../../crm/merge');
    delete require.cache[modulePath];
    const prev = process.env.CRM_DATA_DIR;
    process.env.CRM_DATA_DIR = dataDir;
    try {
        const { loadWhatsAppRosters } = require('../../crm/merge');
        loadWhatsAppRosters(index, outDir);
    } finally {
        if (prev === undefined) delete process.env.CRM_DATA_DIR;
        else process.env.CRM_DATA_DIR = prev;
    }
}

// ---------------------------------------------------------------------------

test('[Rosters]: creates contacts for every participant in a group', () => {
    const { dataDir, waDir, outDir } = setupFixture();
    fs.writeFileSync(path.join(waDir, 'chats.json'), JSON.stringify({
        'Founder Group': {
            meta: {
                id: '120363000000000001@g.us',
                name: 'Founder Group',
                isGroup: true,
                createdAt: '2024-01-01T00:00:00Z',
                owner: '447111111111@c.us',
                participants: [
                    { id: '447111111111@c.us', isAdmin: true, isSuperAdmin: true },
                    { id: '447222222222@c.us', isAdmin: false, isSuperAdmin: false },
                    { id: '447333333333@c.us', isAdmin: false, isSuperAdmin: false },
                ],
            },
            messages: [],
        },
    }));

    const index = new ContactIndex();
    loadRostersWithEnv(dataDir, index, outDir);

    // 3 participants -> 3 contacts
    assert.equal(index.contacts.length, 3);
    for (const contact of index.contacts) {
        assert.equal(contact.groupMemberships.length, 1);
        assert.equal(contact.groupMemberships[0].chatId, '120363000000000001@g.us');
        assert.equal(contact.groupMemberships[0].chatName, 'Founder Group');
        assert.ok(contact.sources.whatsapp, 'WhatsApp source attached');
        assert.equal(contact.sources.whatsapp.fromRoster, true);
    }
});

test('[Rosters]: admin flags flow through from participant to membership', () => {
    const { dataDir, waDir, outDir } = setupFixture();
    fs.writeFileSync(path.join(waDir, 'chats.json'), JSON.stringify({
        'Admin Check': {
            meta: {
                id: '120363000000000002@g.us',
                name: 'Admin Check',
                isGroup: true,
                participants: [
                    { id: '447111111111@c.us', isAdmin: true,  isSuperAdmin: true },
                    { id: '447222222222@c.us', isAdmin: true,  isSuperAdmin: false },
                    { id: '447333333333@c.us', isAdmin: false, isSuperAdmin: false },
                ],
            },
            messages: [],
        },
    }));

    const index = new ContactIndex();
    loadRostersWithEnv(dataDir, index, outDir);

    const byPhone = {};
    for (const c of index.contacts) byPhone[c.phones[0]] = c;

    assert.equal(byPhone['+447111111111'].groupMemberships[0].isSuperAdmin, true);
    assert.equal(byPhone['+447222222222'].groupMemberships[0].isAdmin, true);
    assert.equal(byPhone['+447222222222'].groupMemberships[0].isSuperAdmin, false);
    assert.equal(byPhone['+447333333333'].groupMemberships[0].isAdmin, false);
});

test('[Rosters]: shared members across groups get multiple memberships', () => {
    const { dataDir, waDir, outDir } = setupFixture();
    fs.writeFileSync(path.join(waDir, 'chats.json'), JSON.stringify({
        'Group A': {
            meta: {
                id: 'aaa@g.us', name: 'Group A', isGroup: true,
                participants: [
                    { id: '447111111111@c.us', isAdmin: false, isSuperAdmin: false },
                    { id: '447222222222@c.us', isAdmin: false, isSuperAdmin: false },
                ],
            }, messages: [],
        },
        'Group B': {
            meta: {
                id: 'bbb@g.us', name: 'Group B', isGroup: true,
                participants: [
                    { id: '447222222222@c.us', isAdmin: false, isSuperAdmin: false },
                    { id: '447333333333@c.us', isAdmin: false, isSuperAdmin: false },
                ],
            }, messages: [],
        },
    }));

    const index = new ContactIndex();
    loadRostersWithEnv(dataDir, index, outDir);

    assert.equal(index.contacts.length, 3);
    const shared = index.contacts.find(c => c.phones[0] === '+447222222222');
    assert.ok(shared);
    assert.equal(shared.groupMemberships.length, 2);
    const chatIds = shared.groupMemberships.map(g => g.chatId).sort();
    assert.deepEqual(chatIds, ['aaa@g.us', 'bbb@g.us']);
});

test('[Rosters]: writes group-memberships.json with expected shape', () => {
    const { dataDir, waDir, outDir } = setupFixture();
    fs.writeFileSync(path.join(waDir, 'chats.json'), JSON.stringify({
        'Demo': {
            meta: {
                id: 'demo@g.us', name: 'Demo', isGroup: true,
                createdAt: '2024-05-01T00:00:00Z',
                owner: '447111111111@c.us',
                description: 'Demo group for tests',
                participants: [
                    { id: '447111111111@c.us', isAdmin: true, isSuperAdmin: true },
                    { id: '447222222222@c.us', isAdmin: false, isSuperAdmin: false },
                ],
            }, messages: [],
        },
    }));

    const index = new ContactIndex();
    loadRostersWithEnv(dataDir, index, outDir);

    const memPath = path.join(outDir, 'group-memberships.json');
    assert.ok(fs.existsSync(memPath), 'group-memberships.json written');
    const data = JSON.parse(fs.readFileSync(memPath, 'utf8'));
    const demo = data['demo@g.us'];
    assert.ok(demo);
    assert.equal(demo.name, 'Demo');
    assert.equal(demo.size, 2);
    assert.equal(demo.owner, '447111111111@c.us');
    assert.equal(demo.description, 'Demo group for tests');
    assert.equal(demo.members.length, 2);
});

test('[Rosters]: idempotent on re-run — no duplicate memberships', () => {
    const { dataDir, waDir, outDir } = setupFixture();
    fs.writeFileSync(path.join(waDir, 'chats.json'), JSON.stringify({
        'Once': {
            meta: {
                id: 'once@g.us', name: 'Once', isGroup: true,
                participants: [
                    { id: '447111111111@c.us', isAdmin: false, isSuperAdmin: false },
                ],
            }, messages: [],
        },
    }));

    const index = new ContactIndex();
    loadRostersWithEnv(dataDir, index, outDir);
    loadRostersWithEnv(dataDir, index, outDir); // re-run

    assert.equal(index.contacts.length, 1);
    assert.equal(index.contacts[0].groupMemberships.length, 1);
});

test('[Rosters]: applies lid-map when resolving @lid participants', () => {
    const { dataDir, waDir, outDir } = setupFixture();
    fs.writeFileSync(path.join(waDir, 'chats.json'), JSON.stringify({
        'Privacy': {
            meta: {
                id: 'privacy@g.us', name: 'Privacy', isGroup: true,
                participants: [
                    { id: '100012345@lid', isAdmin: false, isSuperAdmin: false },
                ],
            }, messages: [],
        },
    }));
    fs.writeFileSync(path.join(waDir, 'lid-map.json'), JSON.stringify({
        '100012345@lid': '447999999999@c.us',
    }));

    const index = new ContactIndex();
    loadRostersWithEnv(dataDir, index, outDir);

    assert.equal(index.contacts.length, 1);
    assert.equal(index.contacts[0].phones[0], '+447999999999');
});

test('[Rosters]: skips non-group chats (1-on-1 DMs)', () => {
    const { dataDir, waDir, outDir } = setupFixture();
    fs.writeFileSync(path.join(waDir, 'chats.json'), JSON.stringify({
        '+44 7782 000000': {
            meta: { id: '447782000000@c.us', isGroup: false },
            messages: [],
        },
    }));

    const index = new ContactIndex();
    loadRostersWithEnv(dataDir, index, outDir);

    assert.equal(index.contacts.length, 0);
    const memPath = path.join(outDir, 'group-memberships.json');
    const data = JSON.parse(fs.readFileSync(memPath, 'utf8'));
    assert.deepEqual(data, {});
});

test('[Rosters]: handles missing chats.json gracefully (no throw)', () => {
    const { dataDir, outDir } = setupFixture();
    // No chats.json written

    const index = new ContactIndex();
    // Should not throw
    loadRostersWithEnv(dataDir, index, outDir);
    assert.equal(index.contacts.length, 0);
});
