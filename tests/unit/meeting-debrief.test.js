/**
 * Tests for crm/meeting-debrief.js.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    pendingDebriefs,
    recordDebrief,
    summariseDebrief,
    meetingEndMs,
} = require('../../crm/meeting-debrief');

const NOW = new Date('2026-04-20T12:00:00Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('[Debrief] meetingEndMs uses endAt, falls back to startAt+1h', () => {
    assert.equal(meetingEndMs({ endAt: '2026-04-10T10:00:00Z' }), new Date('2026-04-10T10:00:00Z').getTime());
    assert.equal(meetingEndMs({ startAt: '2026-04-10T09:00:00Z' }), new Date('2026-04-10T10:00:00Z').getTime());
    assert.equal(meetingEndMs({}), null);
});

test('[Debrief] pendingDebriefs includes recent meetings not in store', () => {
    const meetings = [
        { id: 'm1', startAt: hoursAgo(2), endAt: hoursAgo(1) },
        { id: 'm2', startAt: hoursAgo(10), endAt: hoursAgo(9) },
    ];
    const p = pendingDebriefs(meetings, {}, { now: NOW });
    assert.equal(p.length, 2);
});

test('[Debrief] pendingDebriefs excludes meetings with a logged debrief', () => {
    const meetings = [
        { id: 'm1', startAt: hoursAgo(2), endAt: hoursAgo(1) },
    ];
    const p = pendingDebriefs(meetings, { m1: { outcome: 'done', loggedAt: '2026-04-20T00:00:00Z' } }, { now: NOW });
    assert.equal(p.length, 0);
});

test('[Debrief] pendingDebriefs ignores meetings outside lookback window', () => {
    const meetings = [
        { id: 'old', startAt: hoursAgo(100), endAt: hoursAgo(99) },
        { id: 'future', startAt: hoursAgo(-5), endAt: hoursAgo(-4) },
        { id: 'grace', startAt: hoursAgo(0.1), endAt: hoursAgo(0.05) }, // under grace
        { id: 'good', startAt: hoursAgo(3), endAt: hoursAgo(2) },
    ];
    const p = pendingDebriefs(meetings, {}, { now: NOW, lookbackHours: 72, graceMinutes: 15 });
    const ids = p.map(m => m.id);
    assert.deepEqual(ids, ['good']);
});

test('[Debrief] recordDebrief sanitises action items and stageMoves', () => {
    const store = recordDebrief({}, 'm1', {
        outcome: '  good chat  ',
        actionItems: ['follow up', { text: ' buy coffee ', due: '2026-04-30' }, null, { text: '' }],
        stageMoves: [{ contactId: 'c_1', stage: 'Contacted' }, { contactId: null, stage: 'X' }],
    });
    assert.ok(store.m1);
    assert.equal(store.m1.outcome, 'good chat');
    assert.equal(store.m1.actionItems.length, 2);
    assert.equal(store.m1.actionItems[0].text, 'follow up');
    assert.equal(store.m1.actionItems[1].text, 'buy coffee');
    assert.equal(store.m1.stageMoves.length, 1);
});

test('[Debrief] recordDebrief requires meetingId', () => {
    assert.throws(() => recordDebrief({}, '', { outcome: 'x' }));
});

test('[Debrief] summariseDebrief describes the entry', () => {
    const entry = { outcome: 'good', actionItems: [{ text: 'a' }, { text: 'b' }], stageMoves: [] };
    assert.match(summariseDebrief(entry), /2 action items.*notes/);
    assert.equal(summariseDebrief(null), null);
});
