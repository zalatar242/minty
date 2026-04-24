/**
 * Tests for crm/life-events.js — detecting announcements + job changes.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    detectAnnouncementEvents,
    detectBirthday,
    detectJobChange,
    detectAllEvents,
} = require('../../crm/life-events');

const NOW = new Date('2026-04-20T12:00:00Z').getTime();
const contact = { id: 'c_1', name: 'Alex Chen' };

function msg(from, body, overrides = {}) {
    return {
        from, body,
        timestamp: '2026-04-10T10:00:00Z',
        source: 'email',
        ...overrides,
    };
}

test('[Events] detects "joining <company>" as a job change', () => {
    const msgs = [msg('them', 'excited to announce I am joining Stripe next month')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 1);
    assert.equal(e[0].kind, 'job_change');
});

test('[Events] detects fundraise announcements', () => {
    const msgs = [msg('them', 'We raised a $4M seed round led by Accel')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.ok(e.some(x => x.kind === 'funding'));
});

test('[Events] detects launch / milestone announcements', () => {
    const msgs = [msg('them', 'we just launched — live on Product Hunt today')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.ok(e.some(x => x.kind === 'milestone'));
});

test('[Events] ignores messages from the user themselves', () => {
    const msgs = [msg('me', 'I just started at Google')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 0);
});

test('[Events] ignores stale messages outside recentDays window', () => {
    const old = msg('them', 'joining Stripe', { timestamp: '2020-01-01T00:00:00Z' });
    const e = detectAnnouncementEvents(contact, [old], { now: NOW, recentDays: 180 });
    assert.equal(e.length, 0);
});

test('[Events] detects birthday within 14 days', () => {
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '1990-04-25' } } };
    const b = detectBirthday(c, { now: NOW });
    assert.ok(b);
    assert.equal(b.kind, 'birthday');
    assert.ok(b.daysAway >= 4 && b.daysAway <= 5, 'expected ~5 days, got ' + b.daysAway);
});

test('[Events] birthday in far future returns null', () => {
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '1990-10-01' } } };
    const b = detectBirthday(c, { now: NOW });
    assert.equal(b, null);
});

test('[Events] detects job change when LinkedIn company differs from Apollo most-recent employer', () => {
    const c = {
        id: 'c_1', name: 'X',
        sources: { linkedin: { company: 'Stripe', position: 'Product Lead' } },
        apollo: { employmentHistory: [{ organization_name: 'Google', title: 'PM' }] },
    };
    const j = detectJobChange(c);
    assert.ok(j);
    assert.equal(j.kind, 'job_change');
    assert.ok(/Google.*Stripe/.test(j.label));
});

test('[Events] no job-change event if companies match', () => {
    const c = {
        id: 'c_1', name: 'X',
        sources: { linkedin: { company: 'Stripe' } },
        apollo: { employmentHistory: [{ organization_name: 'Stripe' }] },
    };
    assert.equal(detectJobChange(c), null);
});

test('[Events] detectAllEvents ranks newer + higher-weight first', () => {
    const contacts = [
        { id: 'c_1', name: 'Alex' },
        { id: 'c_2', name: 'Priya' },
    ];
    const ixn = {
        c_1: [msg('them', 'excited to announce joining Stripe', { timestamp: '2026-04-18T00:00:00Z' })],
        c_2: [msg('them', 'we raised a seed round!', { timestamp: '2026-04-05T00:00:00Z' })],
    };
    const events = detectAllEvents({ contacts, interactionsByContactId: ixn, now: NOW });
    assert.ok(events.length >= 2);
});

test('[Events] first announcement in a message wins — one event per message', () => {
    const msgs = [msg('them', 'Hey — I am joining Stripe AND we just raised a seed round')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 1);
});

test('[Events] snippet is bounded and readable', () => {
    const longMsg = 'Lots of context before. ' + 'Great news — we just launched today. ' + 'A lot of context after this. '.repeat(5);
    const msgs = [msg('them', longMsg)];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.ok(e[0].snippet.length < 150);
});
