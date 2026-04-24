/**
 * Tests for crm/response-metrics.js — per-contact engagement signals.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    computeContactMetrics,
    pairMessages,
    scoreEngagement,
    labelMetrics,
    isFromSelf,
} = require('../../crm/response-metrics');

function mk(ts, from, opts = {}) {
    return {
        timestamp: ts, from, body: 'x',
        chatId: opts.chatId || 'chat1', source: opts.source || 'whatsapp',
        _contactId: opts.contactId || 'c_1',
    };
}

const SELF = new Set(['me']);

test('[Metrics] isFromSelf matches "me" and any custom self ID', () => {
    assert.ok(isFromSelf('me', SELF));
    assert.ok(isFromSelf('+447911', new Set(['+447911'])));
    assert.equal(isFromSelf('+447911', SELF), false);
});

test('[Metrics] pairMessages matches user→contact within 14d window', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me'),
        mk('2026-04-10T10:30:00Z', 'them'),
        mk('2026-04-11T09:00:00Z', 'me'),
        mk('2026-04-11T10:00:00Z', 'them'),
    ];
    const pairs = pairMessages(msgs, SELF);
    assert.equal(pairs.length, 2);
    for (const p of pairs) {
        assert.ok(p.userMsg);
        assert.ok(p.contactReply);
    }
});

test('[Metrics] pairMessages leaves dangling user messages with no reply', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me'),
        mk('2026-05-10T10:00:00Z', 'them'), // > 14 days
    ];
    const pairs = pairMessages(msgs, SELF);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].contactReply, null);
});

test('[Metrics] computeContactMetrics — 100% reply, fast latency → high score', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me'),
        mk('2026-04-10T10:05:00Z', 'them'),
        mk('2026-04-11T09:00:00Z', 'me'),
        mk('2026-04-11T09:05:00Z', 'them'),
    ];
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.replyRate, 1);
    assert.ok(m.medianReplyLatencyHours < 1);
    assert.ok(m.engagementScore >= 80);
});

test('[Metrics] computeContactMetrics — ghosted contact → low score', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me'),
        mk('2026-04-11T10:00:00Z', 'me'),
        mk('2026-04-12T10:00:00Z', 'me'),
        // no replies
    ];
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.replyRate, 0);
    assert.equal(m.medianReplyLatencyHours, null);
    assert.ok(m.engagementScore < 25);
});

test('[Metrics] initiationRate — 0.5 is balanced', () => {
    const msgs = [];
    // Alternate: they start one, you start one (>24h apart gap each)
    const starts = [
        { ts: '2026-01-01T00:00:00Z', from: 'them' },
        { ts: '2026-01-03T00:00:00Z', from: 'me' },
        { ts: '2026-01-05T00:00:00Z', from: 'them' },
        { ts: '2026-01-07T00:00:00Z', from: 'me' },
    ];
    for (const s of starts) msgs.push(mk(s.ts, s.from));
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.initiationRate, 0.5);
});

test('[Metrics] scoreEngagement is bounded 0..100', () => {
    for (let i = 0; i < 20; i++) {
        const r = Math.random();
        const h = Math.random() * 200;
        const init = Math.random();
        const s = scoreEngagement({ replyRate: r, medianReplyLatencyHours: h, initiationRate: init });
        assert.ok(s >= 0 && s <= 100);
    }
});

test('[Metrics] labelMetrics produces human chips', () => {
    const m = { replyRate: 0.8, medianReplyLatencyHours: 2, userMessages: 10,
        initiationRate: 0.2, theyStarted: 2, youStarted: 8 };
    const chips = labelMetrics(m);
    assert.ok(chips.some(c => c.includes('80%')));
    assert.ok(chips.some(c => c.includes('2h')));
    assert.ok(chips.includes('you reach out'));
});

test('[Metrics] sparse signal — replyRate suppressed if < 3 user messages', () => {
    const m = { replyRate: 0.5, userMessages: 2, medianReplyLatencyHours: null, initiationRate: null };
    const chips = labelMetrics(m);
    assert.ok(!chips.some(c => c.includes('%')));
});

test('[Metrics] empty interactions → zeros, score 0', () => {
    const m = computeContactMetrics([], SELF);
    assert.equal(m.replyRate, null);
    assert.equal(m.engagementScore, 0);
});

test('[Metrics] messages without timestamp are dropped', () => {
    const msgs = [
        { ...mk('2026-04-10T10:00:00Z', 'me'), _contactId: 'c' },
        { from: 'them', body: 'x', _contactId: 'c' }, // no timestamp
    ];
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.userMessages, 1);
    assert.equal(m.replyRate, 0); // no matched reply
});

test('[Metrics] different chat threads are separate', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me', { chatId: 'a' }),
        mk('2026-04-10T10:05:00Z', 'them', { chatId: 'a' }),
        mk('2026-04-11T10:00:00Z', 'me', { chatId: 'b' }),
        // no reply in thread 'b'
    ];
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.userMessages, 2);
    assert.equal(m.contactReplies, 1);
    assert.equal(m.replyRate, 0.5);
});
