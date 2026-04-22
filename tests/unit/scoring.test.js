'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recencyScore, frequencyScore, channelScore, relationshipScore } = require('../../crm/utils');

// ---------------------------------------------------------------------------
// recencyScore
// ---------------------------------------------------------------------------

test('recencyScore: null daysSince returns 0', () => {
    assert.equal(recencyScore(null), 0);
    assert.equal(recencyScore(undefined), 0);
});

test('recencyScore: < 7 days = 100', () => {
    assert.equal(recencyScore(0), 100);
    assert.equal(recencyScore(1), 100);
    assert.equal(recencyScore(6), 100);
});

test('recencyScore: 7–29 days = 80', () => {
    assert.equal(recencyScore(7), 80);
    assert.equal(recencyScore(15), 80);
    assert.equal(recencyScore(29), 80);
});

test('recencyScore: 30–89 days = 60', () => {
    assert.equal(recencyScore(30), 60);
    assert.equal(recencyScore(60), 60);
    assert.equal(recencyScore(89), 60);
});

test('recencyScore: 90–179 days = 30', () => {
    assert.equal(recencyScore(90), 30);
    assert.equal(recencyScore(120), 30);
    assert.equal(recencyScore(179), 30);
});

test('recencyScore: 180–364 days = 10', () => {
    assert.equal(recencyScore(180), 10);
    assert.equal(recencyScore(270), 10);
    assert.equal(recencyScore(364), 10);
});

test('recencyScore: 365+ days = 0', () => {
    assert.equal(recencyScore(365), 0);
    assert.equal(recencyScore(1000), 0);
});

// ---------------------------------------------------------------------------
// frequencyScore
// ---------------------------------------------------------------------------

test('frequencyScore: 0 interactions = 0', () => {
    assert.equal(frequencyScore(0, 100), 0);
    assert.equal(frequencyScore(null, 100), 0);
});

test('frequencyScore: count = p90 gives ~100', () => {
    // log1p(p90) / log1p(p90) = 1, * 100 = 100
    assert.equal(frequencyScore(100, 100), 100);
});

test('frequencyScore: count > p90 is capped at 100', () => {
    assert.equal(frequencyScore(500, 100), 100);
});

test('frequencyScore: count < p90 gives score < 100', () => {
    const score = frequencyScore(10, 100);
    assert.ok(score > 0, 'should be positive');
    assert.ok(score < 100, 'should be less than 100');
});

test('frequencyScore: handles p90=0 or missing without throwing', () => {
    assert.doesNotThrow(() => frequencyScore(5, 0));
    assert.doesNotThrow(() => frequencyScore(5, null));
});

// ---------------------------------------------------------------------------
// channelScore
// ---------------------------------------------------------------------------

test('channelScore: no channels = 0', () => {
    assert.equal(channelScore([]), 0);
    assert.equal(channelScore(null), 0);
});

test('channelScore: 1 channel = 20', () => {
    assert.equal(channelScore(['whatsapp']), 20);
});

test('channelScore: 3 channels = 60', () => {
    assert.equal(channelScore(['whatsapp', 'email', 'linkedin']), 60);
});

test('channelScore: 5 channels = 100', () => {
    assert.equal(channelScore(['whatsapp', 'email', 'linkedin', 'telegram', 'sms']), 100);
});

test('channelScore: more than 5 channels is capped at 100', () => {
    assert.equal(channelScore(['a', 'b', 'c', 'd', 'e', 'f']), 100);
});

// ---------------------------------------------------------------------------
// relationshipScore (composite)
// ---------------------------------------------------------------------------

test('relationshipScore: all 100 = 100', () => {
    assert.equal(relationshipScore(100, 100, 100), 100);
});

test('relationshipScore: all 0 = 0', () => {
    assert.equal(relationshipScore(0, 0, 0), 0);
});

test('relationshipScore: applies weights correctly', () => {
    // recency*0.5 + freq*0.3 + channel*0.2
    // 80*0.5 + 60*0.3 + 60*0.2 = 40 + 18 + 12 = 70
    assert.equal(relationshipScore(80, 60, 60), 70);
});

test('relationshipScore: result rounds to integer', () => {
    const score = relationshipScore(80, 50, 70);
    assert.equal(score, Math.round(score));
});

test('relationshipScore: recently active many-channel contact scores high', () => {
    // daysSince=2 → recency=100, freq=100 (at p90), 3 channels → channel=60
    // 100*0.5 + 100*0.3 + 60*0.2 = 50 + 30 + 12 = 92
    const score = relationshipScore(100, 100, 60);
    assert.equal(score, 92);
});

test('relationshipScore: dormant contact scores low even with history', () => {
    // daysSince=400 → recency=0, freq=80, 1 channel → channel=20
    // 0*0.5 + 80*0.3 + 20*0.2 = 0 + 24 + 4 = 28
    const score = relationshipScore(0, 80, 20);
    assert.equal(score, 28);
});
