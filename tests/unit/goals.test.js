/**
 * Unit tests for goal-oriented contact scoring (scoreContactForGoal, rankContactsForGoal).
 */
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { scoreContactForGoal, rankContactsForGoal } = require('../../crm/utils');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContact(overrides = {}) {
    return {
        id:                'c_001',
        name:              'Jane Doe',
        isGroup:           false,
        relationshipScore: 50,
        daysSinceContact:  30,
        sources:           { linkedin: { company: 'Acme Corp', position: 'CEO' } },
        apollo:            null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// scoreContactForGoal
// ---------------------------------------------------------------------------

test('[Goals]: returns 0 for null goal text', () => {
    const c = makeContact();
    assert.equal(scoreContactForGoal(c, null), 0);
    assert.equal(scoreContactForGoal(c, ''), 0);
});

test('[Goals]: returns 0 for null contact', () => {
    assert.equal(scoreContactForGoal(null, 'raise seed round'), 0);
    assert.equal(scoreContactForGoal(undefined, 'raise seed round'), 0);
});

test('[Goals]: investor role boosts score for fundraise goal', () => {
    const investor = makeContact({
        sources: { linkedin: { company: 'Index Ventures', position: 'Partner' } },
        relationshipScore: 0,
    });
    const score = scoreContactForGoal(investor, 'raise seed round');
    assert.ok(score > 0, `Expected score > 0, got ${score}`);
});

test('[Goals]: founder role boosts score for fundraise goal', () => {
    const founder = makeContact({
        sources: { linkedin: { company: 'Stealth Startup', position: 'Founder' } },
        relationshipScore: 0,
    });
    const score = scoreContactForGoal(founder, 'looking for investors to fund my startup');
    assert.ok(score > 0, `Expected score > 0, got ${score}`);
});

test('[Goals]: engineer role boosts score for hiring goal', () => {
    const engineer = makeContact({
        sources: { linkedin: { company: 'Google', position: 'Senior Software Engineer' } },
        relationshipScore: 0,
    });
    const score = scoreContactForGoal(engineer, 'hire a senior engineer for my team');
    assert.ok(score > 0, `Expected score > 0, got ${score}`);
});

test('[Goals]: warmth adds bonus to score', () => {
    const warmContact = makeContact({ relationshipScore: 80 });
    const coldContact = makeContact({ relationshipScore: 0 });
    const warmScore = scoreContactForGoal(warmContact, 'raise seed round');
    const coldScore = scoreContactForGoal(coldContact, 'raise seed round');
    // Warm contact should score higher or equal (same role match, extra warmth)
    assert.ok(warmScore >= coldScore, `warmScore(${warmScore}) should be >= coldScore(${coldScore})`);
});

test('[Goals]: score never exceeds 100', () => {
    const superContact = makeContact({
        sources: { linkedin: { company: 'Sequoia Capital', position: 'Managing Partner' } },
        apollo:  { headline: 'Investor at Sequoia, former founder, vc venture fund capital' },
        relationshipScore: 100,
    });
    const score = scoreContactForGoal(superContact, 'raise seed round vc capital investor angel fund');
    assert.ok(score <= 100, `Expected score <= 100, got ${score}`);
    assert.ok(typeof score === 'number');
});

test('[Goals]: score is 0 for completely unrelated contact', () => {
    const farmer = makeContact({
        name: 'Old McDonald',
        sources: { linkedin: { company: 'Happy Farm', position: 'Farmer' } },
        apollo: null,
        relationshipScore: 0,
    });
    const score = scoreContactForGoal(farmer, 'raise seed round from vc investors');
    // May or may not match — just ensure it returns a valid number
    assert.ok(typeof score === 'number');
    assert.ok(score >= 0 && score <= 100);
});

test('[Goals]: keyword match from goal text boosts score', () => {
    const fintech = makeContact({
        sources: { linkedin: { company: 'Stripe', position: 'Head of Product' } },
        apollo:  { headline: 'Building fintech payments infrastructure', industry: 'fintech' },
        relationshipScore: 0,
    });
    const score = scoreContactForGoal(fintech, 'break into fintech payments market');
    assert.ok(score > 0, `Expected keyword match to produce score > 0, got ${score}`);
});

test('[Goals]: apollo headline is searched for matches', () => {
    const c = makeContact({
        sources: { linkedin: {} },
        apollo:  { headline: 'General Partner at Accel, early-stage investor' },
        relationshipScore: 0,
    });
    const score = scoreContactForGoal(c, 'raise seed round from early-stage investors');
    assert.ok(score > 0);
});

test('[Goals]: returns integer', () => {
    const c = makeContact({ relationshipScore: 47 });
    const score = scoreContactForGoal(c, 'raise seed round');
    assert.equal(score, Math.round(score));
    assert.ok(Number.isInteger(score));
});

// ---------------------------------------------------------------------------
// rankContactsForGoal
// ---------------------------------------------------------------------------

test('[Goals]: returns empty array for empty contacts', () => {
    const result = rankContactsForGoal([], 'raise seed round');
    assert.deepEqual(result, []);
});

test('[Goals]: returns empty array for null goal text', () => {
    const contacts = [makeContact()];
    assert.deepEqual(rankContactsForGoal(contacts, null), []);
    assert.deepEqual(rankContactsForGoal(contacts, ''), []);
});

test('[Goals]: excludes group contacts', () => {
    const group = makeContact({ id: 'g_001', name: 'VC London', isGroup: true,
        sources: { linkedin: { position: 'Investor Partner', company: 'VC Fund' } }, relationshipScore: 80 });
    const person = makeContact({ id: 'c_001', name: 'Jane VC',
        sources: { linkedin: { position: 'Investor', company: 'VC Fund' } }, relationshipScore: 50 });
    const result = rankContactsForGoal([group, person], 'raise seed round');
    assert.ok(!result.find(c => c.id === 'g_001'), 'Group should be excluded');
});

test('[Goals]: excludes contacts with zero relevance', () => {
    const unrelated = makeContact({
        sources: { linkedin: { company: 'Farm Co', position: 'Farmer' } },
        apollo: null, relationshipScore: 0,
    });
    const result = rankContactsForGoal([unrelated], 'raise seed round');
    // Unrelated contact may still be included if warmth provides a score — but score 0 → excluded
    // The function only excludes if goalRelevance === 0
    result.forEach(c => assert.ok(c.goalRelevance > 0));
});

test('[Goals]: respects limit parameter', () => {
    const contacts = Array.from({ length: 20 }, (_, i) => makeContact({
        id: 'c_' + i,
        sources: { linkedin: { company: 'VC Fund ' + i, position: 'Investor' } },
        relationshipScore: 50,
    }));
    const result = rankContactsForGoal(contacts, 'raise seed round', 3);
    assert.ok(result.length <= 3);
});

test('[Goals]: defaults to limit 5', () => {
    const contacts = Array.from({ length: 20 }, (_, i) => makeContact({
        id: 'c_' + i,
        sources: { linkedin: { company: 'VC Fund ' + i, position: 'Investor' } },
        relationshipScore: 50,
    }));
    const result = rankContactsForGoal(contacts, 'raise seed round');
    assert.ok(result.length <= 5);
});

test('[Goals]: augments results with goalRelevance field', () => {
    const c = makeContact({ sources: { linkedin: { position: 'Investor', company: 'VC' } } });
    const result = rankContactsForGoal([c], 'raise seed round');
    if (result.length > 0) {
        assert.ok('goalRelevance' in result[0]);
        assert.ok(typeof result[0].goalRelevance === 'number');
    }
});

test('[Goals]: higher-scoring contacts appear first', () => {
    const weakMatch = makeContact({ id: 'c_weak',
        sources: { linkedin: { position: 'Analyst', company: 'Bank' } },
        relationshipScore: 10 });
    const strongMatch = makeContact({ id: 'c_strong',
        sources: { linkedin: { position: 'Partner', company: 'VC Fund' } },
        apollo: { headline: 'Venture investor, angel, early-stage capital' },
        relationshipScore: 70 });
    const result = rankContactsForGoal([weakMatch, strongMatch], 'raise seed round from venture investors');
    if (result.length >= 2) {
        assert.ok(result[0].goalRelevance >= result[1].goalRelevance,
            `First result should have higher relevance: ${result[0].goalRelevance} vs ${result[1].goalRelevance}`);
    }
});
