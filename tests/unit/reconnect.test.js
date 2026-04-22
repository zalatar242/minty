'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    daysToTimePhrase,
    buildReconnectTemplate,
    shuffleSentences,
    alternateOpener,
    regenerateDraft,
} = require('../../crm/reconnect');

// ---------------------------------------------------------------------------
// daysToTimePhrase
// ---------------------------------------------------------------------------

test('reconnect/daysToTimePhrase: null → "a while"', () => {
    assert.equal(daysToTimePhrase(null), 'a while');
});

test('reconnect/daysToTimePhrase: undefined → "a while"', () => {
    assert.equal(daysToTimePhrase(undefined), 'a while');
});

test('reconnect/daysToTimePhrase: 3 days → "recently"', () => {
    assert.equal(daysToTimePhrase(3), 'recently');
});

test('reconnect/daysToTimePhrase: 14 days → "a couple weeks"', () => {
    assert.equal(daysToTimePhrase(14), 'a couple weeks');
});

test('reconnect/daysToTimePhrase: 60 days → "a couple months"', () => {
    assert.equal(daysToTimePhrase(60), 'a couple months');
});

test('reconnect/daysToTimePhrase: 90 days → "a couple months"', () => {
    assert.equal(daysToTimePhrase(90), 'a couple months');
});

test('reconnect/daysToTimePhrase: 200 days → "a few months"', () => {
    assert.equal(daysToTimePhrase(200), 'a few months');
});

test('reconnect/daysToTimePhrase: 400 days → "a while"', () => {
    assert.equal(daysToTimePhrase(400), 'a while');
});

// ---------------------------------------------------------------------------
// buildReconnectTemplate
// ---------------------------------------------------------------------------

const makeContact = (overrides = {}) => ({
    name: 'Sarah Chen',
    daysSinceContact: 45,
    sources: { linkedin: { company: 'Acme Corp' }, whatsapp: null },
    apollo: {},
    activeChannels: ['linkedin'],
    ...overrides,
});

test('reconnect/buildReconnectTemplate: returns a non-empty string', () => {
    const draft = buildReconnectTemplate(makeContact());
    assert.ok(typeof draft === 'string');
    assert.ok(draft.length > 20);
});

test('reconnect/buildReconnectTemplate: uses first name only', () => {
    const draft = buildReconnectTemplate(makeContact({ name: 'Sarah Chen' }));
    assert.ok(draft.includes('Sarah'));
    assert.ok(!draft.includes('Sarah Chen'));
});

test('reconnect/buildReconnectTemplate: includes company when available', () => {
    const draft = buildReconnectTemplate(makeContact());
    assert.ok(draft.includes('Acme Corp'));
});

test('reconnect/buildReconnectTemplate: omits company line when none available', () => {
    const contact = makeContact({ sources: { linkedin: null } });
    const draft = buildReconnectTemplate(contact);
    assert.ok(!draft.includes('undefined'));
    assert.ok(!draft.includes('null'));
});

test('reconnect/buildReconnectTemplate: uses topic from insights', () => {
    const insights = { topics: ['machine learning', 'career change'], openLoops: [], keywords: [] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    assert.ok(draft.includes('machine learning'));
});

test('reconnect/buildReconnectTemplate: uses open loop from insights', () => {
    const insights = { topics: [], openLoops: ['follow up on the job application'], keywords: [] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    assert.ok(draft.toLowerCase().includes('follow up'));
});

test('reconnect/buildReconnectTemplate: falls back gracefully with no insights and no snippets', () => {
    const draft = buildReconnectTemplate(makeContact({ name: 'Jay' }), null, []);
    assert.ok(draft.startsWith('Hey Jay'));
    assert.ok(!draft.includes('undefined'));
    assert.ok(!draft.includes('null'));
});

test('reconnect/buildReconnectTemplate: uses recent snippet when no topic in insights', () => {
    const snippets = ['machine learning conference'];
    const draft = buildReconnectTemplate(makeContact({ name: 'Jay' }), null, snippets);
    assert.ok(draft.length > 20);
    assert.ok(!draft.includes('undefined'));
});

test('reconnect/buildReconnectTemplate: handles missing name gracefully', () => {
    const draft = buildReconnectTemplate(makeContact({ name: null }), null, []);
    assert.ok(draft.includes('there'));
    assert.ok(!draft.includes('null'));
});

// ---------------------------------------------------------------------------
// shuffleSentences
// ---------------------------------------------------------------------------

test('reconnect/shuffleSentences: returns string', () => {
    const result = shuffleSentences('Hello there. How are you? Hope all is well.');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
});

test('reconnect/shuffleSentences: single sentence returns unchanged', () => {
    const input = 'Just one sentence.';
    assert.equal(shuffleSentences(input), input);
});

test('reconnect/shuffleSentences: two sentences returns unchanged (no middle to shuffle)', () => {
    const input = 'First sentence. Second sentence.';
    assert.equal(shuffleSentences(input), input);
});

test('reconnect/shuffleSentences: three+ sentences modifies middle', () => {
    const input = 'Start sentence. Middle one. Middle two. End sentence.';
    const result = shuffleSentences(input);
    // First and last should be preserved
    assert.ok(result.startsWith('Start sentence.'));
    assert.ok(result.trimEnd().endsWith('End sentence.'));
    // Should contain all sentences
    assert.ok(result.includes('Middle one.'));
    assert.ok(result.includes('Middle two.'));
});

test('reconnect/shuffleSentences: preserves all content', () => {
    const input = 'Hey Sarah. I miss our chats. Hope you are well. Catch up soon?';
    const result = shuffleSentences(input);
    const originalWords = input.replace(/[.?!]/g, '').split(/\s+/).sort();
    const resultWords = result.replace(/[.?!]/g, '').split(/\s+/).sort();
    assert.deepEqual(originalWords, resultWords);
});

// ---------------------------------------------------------------------------
// alternateOpener
// ---------------------------------------------------------------------------

test('reconnect/alternateOpener: returns string with name', () => {
    const result = alternateOpener('Original draft sentence.', 'Sarah');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Sarah'));
});

test('reconnect/alternateOpener: result differs from input', () => {
    const input = 'Hey Sarah, it has been a while. Hope you are well.';
    const result = alternateOpener(input, 'Sarah');
    assert.notEqual(result, input);
});

test('reconnect/alternateOpener: uses "there" when no firstName', () => {
    const result = alternateOpener('Some draft.', '');
    assert.ok(result.includes('there'));
});

// ---------------------------------------------------------------------------
// regenerateDraft
// ---------------------------------------------------------------------------

test('reconnect/regenerateDraft: returns a string', () => {
    const result = regenerateDraft('Hey Jay. Hope all is well. Looking forward to catching up.', 'Jay');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
});

test('reconnect/regenerateDraft: result differs from input for shuffleable draft', () => {
    const input = 'Hey Sarah. I wanted to reach out. Hope you are well. Would love to catch up.';
    const result = regenerateDraft(input, 'Sarah');
    assert.notEqual(result, input);
});

test('reconnect/regenerateDraft: never produces empty string', () => {
    const result = regenerateDraft('', 'Jay');
    assert.ok(typeof result === 'string');
});

test('reconnect/regenerateDraft: no null or undefined in output', () => {
    const result = regenerateDraft('Short text.', 'Jay');
    assert.ok(!result.includes('null'));
    assert.ok(!result.includes('undefined'));
});
