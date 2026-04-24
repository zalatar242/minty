/**
 * Tests for crm/palette.js — backing search for the Cmd+K palette.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paletteSearch, scoreString, NAV_TARGETS } = require('../../crm/palette');

function mkContact(overrides = {}) {
    return {
        id: 'c_1', name: 'Alex Chen', phones: [], emails: ['alex@stripe.com'], notes: null, tags: [],
        sources: { whatsapp: null, linkedin: { name: 'Alex Chen', company: 'Stripe', position: 'Engineering Manager' }, telegram: null, email: null, googleContacts: null, sms: null },
        lastContactedAt: null, createdAt: '2024-01-01', updatedAt: '2024-01-01',
        relationshipScore: 55,
        ...overrides,
    };
}

test('[Palette] scoreString grades matches by quality', () => {
    assert.equal(scoreString('Alex Chen', 'alex chen'), 100);
    assert.ok(scoreString('Alex Chen', 'alex') >= 70);
    assert.ok(scoreString('Lead Engineer at Stripe', 'stripe') >= 40);
    assert.equal(scoreString('bob', 'alex'), 0);
    assert.equal(scoreString('', 'x'), 0);
    assert.equal(scoreString('x', ''), 0);
});

test('[Palette] empty query returns nav + top contacts', () => {
    const contacts = [mkContact({ relationshipScore: 90 }), mkContact({ id: 'c_2', name: 'Bob', relationshipScore: 30 })];
    const { results } = paletteSearch('', { contacts, interactions: [], goals: [], companies: [] });
    const types = new Set(results.map(r => r.type));
    assert.ok(types.has('nav'));
    assert.ok(types.has('contact'));
    // Top contact should come before lower-score one
    const contactResults = results.filter(r => r.type === 'contact');
    assert.equal(contactResults[0].id, 'c_1'); // higher score wins
});

test('[Palette] ranks exact-name contact hit above partial company hit', () => {
    const contacts = [
        mkContact({ id: 'c_alex', name: 'Alex Chen' }),
        mkContact({ id: 'c_stripe_guy', name: 'Bob Smith', sources: { linkedin: { company: 'Stripe Alex' } } }),
    ];
    const { results } = paletteSearch('alex', { contacts, interactions: [], goals: [], companies: [] });
    const firstContact = results.find(r => r.type === 'contact');
    assert.equal(firstContact.id, 'c_alex');
});

test('[Palette] goal query matches goal text', () => {
    const goals = [
        { id: 'g_1', text: 'Raise a seed round' },
        { id: 'g_2', text: 'Hire senior engineer' },
    ];
    const { results } = paletteSearch('hire', { contacts: [], interactions: [], goals, companies: [] });
    const goalResult = results.find(r => r.type === 'goal');
    assert.ok(goalResult);
    assert.equal(goalResult.id, 'g_2');
});

test('[Palette] nav keywords match synonyms', () => {
    const { results } = paletteSearch('search', { contacts: [], interactions: [], goals: [], companies: [] });
    const ask = results.find(r => r.type === 'nav' && r.action === 'ask');
    assert.ok(ask, 'nav "ask" should match keyword "search"');
});

test('[Palette] conversation results appear when query is long enough', () => {
    const interactions = [
        { id: 'i_1', source: 'email', timestamp: '2026-04-10T00:00:00Z', body: 'Let\'s grab coffee next week', _contactId: 'c_1', _contactName: 'Alex' },
    ];
    const { results } = paletteSearch('coffee', { contacts: [], interactions, goals: [], companies: [] });
    const conv = results.find(r => r.type === 'conversation');
    assert.ok(conv, 'should find conversation');
    assert.ok(conv.snippet.toLowerCase().includes('coffee'));
});

test('[Palette] 2-char query skips conversation search (performance)', () => {
    const interactions = Array.from({ length: 5000 }, (_, i) => ({
        id: 'i_' + i, source: 'email', body: 'ai stuff',
    }));
    const before = process.hrtime.bigint();
    paletteSearch('ai', { contacts: [], interactions, goals: [], companies: [] });
    const ms = Number(process.hrtime.bigint() - before) / 1e6;
    assert.ok(ms < 50, `short query should skip FTS (took ${ms}ms)`);
});

test('[Palette] NAV_TARGETS are consistent', () => {
    for (const n of NAV_TARGETS) {
        assert.ok(n.action && typeof n.action === 'string');
        assert.ok(n.label && typeof n.label === 'string');
        assert.ok(n.description && typeof n.description === 'string');
    }
});

test('[Palette] company matches surface with count sublabel', () => {
    const companies = [{ name: 'Stripe', count: 5 }];
    const { results } = paletteSearch('stripe', { contacts: [], interactions: [], goals: [], companies });
    const co = results.find(r => r.type === 'company');
    assert.ok(co);
    assert.ok(co.sublabel.includes('5'));
});
