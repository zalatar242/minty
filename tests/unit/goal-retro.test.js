/**
 * Tests for crm/goal-retro.js — goal post-mortem synthesis.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGoalRetro, narrate } = require('../../crm/goal-retro');

function mk(id, overrides = {}) {
    return {
        id, name: id, phones: [], emails: [],
        sources: { linkedin: { company: 'X' }, googleContacts: null, whatsapp: null, telegram: null, email: null, sms: null },
        relationshipScore: 50, daysSinceContact: null, isGroup: false,
        ...overrides,
    };
}

const NOW = new Date('2026-04-20T12:00:00Z').getTime();
const SELF = new Set(['me']);

test('[Retro] empty goal → no-one-in-pipeline narrative', () => {
    const goal = { id: 'g_1', text: 'Raise', stages: ['A', 'B', 'C'], assignments: {} };
    const r = buildGoalRetro(goal, [], {}, SELF, NOW);
    assert.equal(r.aggregate.totalAssigned, 0);
    assert.match(r.narrative, /No one is in this goal/);
});

test('[Retro] funnel counts per stage are correct', () => {
    const goal = {
        id: 'g_1', text: 'Hire',
        stages: ['A', 'B', 'C'],
        assignments: {
            c_1: { stage: 'A', updatedAt: '2026-04-10T00:00:00Z' },
            c_2: { stage: 'A', updatedAt: '2026-04-10T00:00:00Z' },
            c_3: { stage: 'B', updatedAt: '2026-04-10T00:00:00Z' },
            c_4: { stage: 'C', updatedAt: '2026-04-10T00:00:00Z' },
        },
    };
    const contacts = ['c_1', 'c_2', 'c_3', 'c_4'].map(id => mk(id));
    const r = buildGoalRetro(goal, contacts, {}, SELF, NOW);
    assert.equal(r.funnel[0].count, 2);
    assert.equal(r.funnel[1].count, 1);
    assert.equal(r.funnel[2].count, 1);
    assert.equal(r.aggregate.totalAssigned, 4);
    assert.equal(r.aggregate.progressed, 50); // 2 of 4 past stage 0
});

test('[Retro] stuck contacts (> 14 days since stage update) are flagged', () => {
    const goal = {
        id: 'g_1', text: 'X', stages: ['A', 'B'],
        assignments: {
            c_1: { stage: 'A', updatedAt: '2026-03-01T00:00:00Z' }, // > 14 days ago
            c_2: { stage: 'A', updatedAt: '2026-04-15T00:00:00Z' }, // recent
        },
    };
    const contacts = [mk('c_1'), mk('c_2')];
    const r = buildGoalRetro(goal, contacts, {}, SELF, NOW);
    assert.equal(r.stuck.length, 1);
    assert.equal(r.stuck[0].id, 'c_1');
    assert.equal(r.moving.length, 1);
    assert.equal(r.moving[0].id, 'c_2');
});

test('[Retro] ghosted detection — user messaged, 0 replies, daysSinceContact >= 14', () => {
    const goal = {
        id: 'g_1', text: 'X', stages: ['A'],
        assignments: { c_1: { stage: 'A', updatedAt: '2026-04-10T00:00:00Z' } },
    };
    const contact = mk('c_1', { daysSinceContact: 30 });
    const interactions = [
        { from: 'me', to: 'c_1', timestamp: '2026-03-20T00:00:00Z', body: 'hi', _contactId: 'c_1' },
        { from: 'me', to: 'c_1', timestamp: '2026-03-25T00:00:00Z', body: 'checking in', _contactId: 'c_1' },
    ];
    const r = buildGoalRetro(goal, [contact], { c_1: interactions }, SELF, NOW);
    assert.ok(r.ghosted.some(g => g.id === 'c_1'));
});

test('[Retro] replied detection — high reply rate, low latency', () => {
    const goal = {
        id: 'g_1', text: 'X', stages: ['A'],
        assignments: { c_1: { stage: 'A', updatedAt: '2026-04-15T00:00:00Z' } },
    };
    const contact = mk('c_1', { daysSinceContact: 2 });
    const interactions = [
        { from: 'me', to: 'c_1', timestamp: '2026-04-10T10:00:00Z', body: 'hi', _contactId: 'c_1' },
        { from: 'them', to: 'me', timestamp: '2026-04-10T10:30:00Z', body: 'yo', _contactId: 'c_1' },
        { from: 'me', to: 'c_1', timestamp: '2026-04-12T10:00:00Z', body: 'follow up', _contactId: 'c_1' },
        { from: 'them', to: 'me', timestamp: '2026-04-12T11:00:00Z', body: 'sure', _contactId: 'c_1' },
    ];
    const r = buildGoalRetro(goal, [contact], { c_1: interactions }, SELF, NOW);
    assert.ok(r.replied.some(x => x.id === 'c_1'));
});

test('[Retro] narrative mentions stuck when no movement', () => {
    const agg = { totalAssigned: 3, progressed: 0, stuck: 3, moving: 0, ghosted: 0, replied: 0 };
    const funnel = [{ stage: 'A', count: 3, contacts: [] }];
    const n = narrate({ text: 'Foo' }, agg, ['A'], funnel);
    assert.match(n, /No movement in 14 days/);
});

test('[Retro] narrative mentions strong response when ≥ 1/3 replied promptly', () => {
    const agg = { totalAssigned: 6, progressed: 50, stuck: 0, moving: 3, ghosted: 0, replied: 3 };
    const funnel = [{ stage: 'A', count: 3, contacts: [] }, { stage: 'B', count: 3, contacts: [] }];
    const n = narrate({ text: 'X' }, agg, ['A', 'B'], funnel);
    assert.match(n, /momentum|Strong response/);
});

test('[Retro] generatedAt is ISO', () => {
    const r = buildGoalRetro({ id: 'g_1', text: 'X', stages: ['A'], assignments: {} }, [], {}, SELF, NOW);
    assert.match(r.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});
