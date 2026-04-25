/**
 * Tests for WhatsApp from-id resolution behaviour:
 *   - merge.js: string-form participants build proper rosters
 *   - merge.js: group messages attribute to author, not the @g.us chat id
 *   - server.js (via shape): @lid contacts get marked isAnonymousLid
 *
 * Real WhatsApp exports use string participants and have group `from` set to
 * the chat id. The seeded dev data was using object form participants and
 * sender-as-from. These tests pin the real shape so the resolver keeps
 * working as the codebase evolves.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');

function setupRealishWa(dir) {
    const wa = path.join(dir, 'whatsapp');
    fs.mkdirSync(wa, { recursive: true });
    // Real shape: contacts.json keyed by id; @lid entries with no name; @g.us
    // entries with proper names; @c.us with name only when the user saved them.
    fs.writeFileSync(path.join(wa, 'contacts.json'), JSON.stringify({
        '447383719797@c.us':                { name: 'Saved Friend', number: '447383719797', isMyContact: true },
        '447900000001@c.us':                { name: null,           number: '447900000001', isMyContact: false },
        '105823917310190@lid':              { name: null,           number: '105823917310190', isMyContact: false },
        '120363168579174704@g.us':          { name: 'UCL AI Society', number: null, isMyContact: false },
    }));
    fs.writeFileSync(path.join(wa, 'chats.json'), JSON.stringify({
        // Group chat with string participants (real shape) — and group messages
        // with from=<group id>, author=<sender id>
        'UCL AI Society': {
            meta: {
                id: '120363168579174704@g.us',
                isGroup: true,
                participants: [
                    '447383719797@c.us',
                    '447900000001@c.us',
                    '105823917310190@lid',
                ],
            },
            messages: [
                { from: '120363168579174704@g.us', author: '447383719797@c.us', timestamp: '2026-04-10T10:00:00Z', body: 'hi all', type: 'chat' },
                { from: '120363168579174704@g.us', author: '105823917310190@lid', timestamp: '2026-04-10T10:01:00Z', body: 'anon msg', type: 'chat' },
                { from: '120363168579174704@g.us', author: '447900000001@c.us', timestamp: '2026-04-10T10:02:00Z', body: 'phone msg', type: 'chat' },
            ],
        },
    }));
}

test('[WA Resolution] merge handles string-form participants (real shape)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-wa-real-'));
    setupRealishWa(dir);

    execFileSync('node', [path.join(ROOT, 'crm/merge.js')], {
        cwd: ROOT,
        env: { ...process.env, CRM_DATA_DIR: dir, CRM_OUT_DIR: path.join(dir, 'unified') },
        encoding: 'utf8',
    });

    const memb = JSON.parse(fs.readFileSync(path.join(dir, 'unified/group-memberships.json'), 'utf8'));
    const group = memb['120363168579174704@g.us'];
    assert.ok(group, 'group memberships record exists');
    assert.equal(group.size, 3, 'all 3 string-form participants picked up');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('[WA Resolution] merge picks group messages\' author for from attribution', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-wa-author-'));
    setupRealishWa(dir);

    execFileSync('node', [path.join(ROOT, 'crm/merge.js')], {
        cwd: ROOT,
        env: { ...process.env, CRM_DATA_DIR: dir, CRM_OUT_DIR: path.join(dir, 'unified') },
        encoding: 'utf8',
    });

    const interactions = JSON.parse(fs.readFileSync(path.join(dir, 'unified/interactions.json'), 'utf8'));
    const wa = interactions.filter(i => i.source === 'whatsapp');
    assert.equal(wa.length, 3);
    // None of them should have from === the group id (since we use author for groups)
    for (const i of wa) {
        assert.notEqual(i.from, '120363168579174704@g.us',
            'group message from should be the author, not the group id');
    }
    // All three different authors should be represented
    const fromIds = wa.map(i => i.from).sort();
    assert.deepEqual(fromIds, [
        '105823917310190@lid',
        '447383719797@c.us',
        '447900000001@c.us',
    ].sort());

    fs.rmSync(dir, { recursive: true, force: true });
});

test('[WA Resolution] @lid contacts get marked isAnonymousLid via roster pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-wa-lid-'));
    setupRealishWa(dir);

    execFileSync('node', [path.join(ROOT, 'crm/merge.js')], {
        cwd: ROOT,
        env: { ...process.env, CRM_DATA_DIR: dir, CRM_OUT_DIR: path.join(dir, 'unified') },
        encoding: 'utf8',
    });

    const contacts = JSON.parse(fs.readFileSync(path.join(dir, 'unified/contacts.json'), 'utf8'));
    const lidContact = contacts.find(c => c.sources?.whatsapp?.id === '105823917310190@lid');
    assert.ok(lidContact, '@lid participant is upserted');
    assert.equal(lidContact.isAnonymousLid, true);
    assert.equal(lidContact.name, null);

    fs.rmSync(dir, { recursive: true, force: true });
});
