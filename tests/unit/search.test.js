/**
 * Tests for crm/search.js — the universal FTS over interactions.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    parseQuery,
    searchInteractions,
    findAll,
    findPrefix,
    dominantTokens,
} = require('../../crm/search');

function mkInter(overrides = {}) {
    return {
        id: 'i_1',
        source: 'email',
        timestamp: '2026-04-15T10:00:00.000Z',
        from: 'alex@example.com',
        to: 'me',
        body: 'Following up on the fundraise — can we grab coffee?',
        subject: 'Re: quick chat',
        chatId: 'alex@example.com',
        chatName: 'Alex Chen',
        ...overrides,
    };
}

test('[Search] parseQuery handles tokens, phrases, prefixes, negation', () => {
    assert.deepEqual(parseQuery(''), []);
    assert.deepEqual(parseQuery('foo bar'), [
        { kind: 'token', value: 'foo', negated: false },
        { kind: 'token', value: 'bar', negated: false },
    ]);
    assert.deepEqual(parseQuery('"exact phrase"'), [
        { kind: 'phrase', value: 'exact phrase', negated: false },
    ]);
    assert.deepEqual(parseQuery('invest* -spam'), [
        { kind: 'prefix', value: 'invest', negated: false },
        { kind: 'token', value: 'spam', negated: true },
    ]);
    assert.deepEqual(parseQuery('-"no way"'), [
        { kind: 'phrase', value: 'no way', negated: true },
    ]);
});

test('[Search] findAll returns all match offsets', () => {
    assert.deepEqual(findAll('aaaaab', 'a'), [0, 1, 2, 3, 4]);
    assert.deepEqual(findAll('no match here', 'zz'), []);
    assert.deepEqual(findAll('CASE case CASE', 'case'), [0, 5, 10]);
});

test('[Search] findPrefix matches word-boundary prefixes', () => {
    const text = 'investor invest investigate invite';
    const matches = findPrefix(text, 'invest');
    assert.equal(matches.length, 3); // "invite" should NOT match (no 'invest' prefix)
});

test('[Search] single-token query matches body', () => {
    const interactions = [
        mkInter({ body: 'Coffee soon?', timestamp: '2026-04-10T00:00:00Z' }),
        mkInter({ id: 'i_2', body: 'Meeting at 3pm', timestamp: '2026-04-11T00:00:00Z' }),
    ];
    const r = searchInteractions(interactions, 'coffee');
    assert.equal(r.results.length, 1);
    assert.ok(r.results[0].snippet.toLowerCase().includes('coffee'));
});

test('[Search] AND semantics — all tokens must match', () => {
    const interactions = [
        mkInter({ body: 'Fundraise update and coffee plans' }),
        mkInter({ id: 'i_2', body: 'Just coffee' }),
        mkInter({ id: 'i_3', body: 'Fundraise only' }),
    ];
    const r = searchInteractions(interactions, 'fundraise coffee');
    assert.equal(r.results.length, 1);
    assert.ok(r.results[0].snippet.toLowerCase().includes('fundraise'));
});

test('[Search] phrase search requires contiguous match', () => {
    const interactions = [
        mkInter({ body: 'it was an intro to the partner meeting' }),
        mkInter({ id: 'i_2', body: 'intro meeting with the partner' }),
    ];
    const r = searchInteractions(interactions, '"partner meeting"');
    assert.equal(r.results.length, 1);
});

test('[Search] negation excludes matching interactions', () => {
    const interactions = [
        mkInter({ body: 'coffee talk' }),
        mkInter({ id: 'i_2', body: 'coffee spam call' }),
    ];
    const r = searchInteractions(interactions, 'coffee -spam');
    assert.equal(r.results.length, 1);
    assert.ok(!r.results[0].snippet.toLowerCase().includes('spam'));
});

test('[Search] prefix match catches inflections', () => {
    const interactions = [
        mkInter({ body: 'she is an angel investor' }),
        mkInter({ id: 'i_2', body: 'they are investing in seed rounds' }),
        mkInter({ id: 'i_3', body: 'I was invited to lunch' }),
    ];
    const r = searchInteractions(interactions, 'invest*');
    // Should hit the two invest* messages but NOT the "invited" one
    assert.equal(r.results.length, 2);
    const ids = r.results.map(x => x.snippet.toLowerCase());
    assert.ok(ids.some(s => s.includes('investor')));
    assert.ok(ids.some(s => s.includes('investing')));
    assert.ok(!ids.some(s => s.includes('invited')));
});

test('[Search] source filter narrows results', () => {
    const interactions = [
        mkInter({ source: 'email', body: 'coffee' }),
        mkInter({ id: 'i_2', source: 'whatsapp', body: 'coffee' }),
        mkInter({ id: 'i_3', source: 'linkedin', body: 'coffee' }),
    ];
    const r = searchInteractions(interactions, 'coffee', { source: ['email', 'linkedin'] });
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results.map(x => x.source).sort(), ['email', 'linkedin']);
});

test('[Search] since/until date filter', () => {
    const interactions = [
        mkInter({ timestamp: '2026-01-01T00:00:00Z', body: 'old coffee' }),
        mkInter({ id: 'i_2', timestamp: '2026-04-10T00:00:00Z', body: 'fresh coffee' }),
    ];
    const r = searchInteractions(interactions, 'coffee', { since: '2026-03-01T00:00:00Z' });
    assert.equal(r.results.length, 1);
    assert.ok(r.results[0].snippet.toLowerCase().includes('fresh'));
});

test('[Search] excludeGroups skips WhatsApp @g.us chats', () => {
    const interactions = [
        mkInter({ chatId: 'some-group@g.us', body: 'pizza tonight' }),
        mkInter({ id: 'i_2', chatId: 'direct@c.us', body: 'pizza?' }),
    ];
    const r = searchInteractions(interactions, 'pizza');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].chatId, 'direct@c.us');
});

test('[Search] match offsets point to snippet coordinates', () => {
    const interactions = [
        mkInter({ body: 'a'.repeat(100) + ' coffee ' + 'b'.repeat(200) }),
    ];
    const r = searchInteractions(interactions, 'coffee');
    const hit = r.results[0];
    for (const m of hit.matches) {
        assert.equal(
            hit.snippet.slice(m.start, m.start + m.length).toLowerCase(),
            'coffee',
        );
    }
});

test('[Search] scoring ranks multi-match + recent over single + old', () => {
    const interactions = [
        mkInter({ id: 'a', timestamp: '2020-01-01T00:00:00Z', body: 'coffee coffee coffee' }),
        mkInter({ id: 'b', timestamp: '2026-04-20T00:00:00Z', body: 'coffee' }),
    ];
    const r = searchInteractions(interactions, 'coffee');
    // Recent single-hit should beat old triple-hit when we normalize recency
    assert.equal(r.results[0].source, 'email'); // both are email; identify by timestamp
    assert.ok(new Date(r.results[0].timestamp) > new Date(r.results[1].timestamp));
});

test('[Search] empty query returns no results', () => {
    const interactions = [mkInter({ body: 'anything' })];
    const r = searchInteractions(interactions, '');
    assert.equal(r.results.length, 0);
    assert.equal(r.total, 0);
});

test('[Search] limit caps result count', () => {
    const interactions = Array.from({ length: 60 }, (_, i) =>
        mkInter({ id: 'i_' + i, body: 'coffee ' + i, timestamp: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` })
    );
    const r = searchInteractions(interactions, 'coffee', { limit: 10 });
    assert.equal(r.results.length, 10);
});

test('[Search] dominantTokens drops stop-words and hapaxes', () => {
    const text = 'fundraise round round investor seed round the the and but';
    const toks = dominantTokens(text, { min: 2, topN: 5 });
    const names = toks.map(t => t.token);
    assert.ok(names.includes('round'));
    assert.ok(!names.includes('the'));
    assert.ok(!names.includes('fundraise')); // appears only once — excluded by min:2
});
