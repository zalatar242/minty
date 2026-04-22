'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseQuery,
    filterIndex,
    extractLocations,
    extractRoles,
    extractIntent,
    buildMeetScore,
    buildIndexEntry,
    extractContactFields,
    getSeniorityTier,
    getRolesFromTitle,
    normalizeLocation,
    describeQuery,
} = require('../../crm/network-query');

// ---------------------------------------------------------------------------
// extractLocations
// ---------------------------------------------------------------------------

test('[NetworkQuery]: extractLocations — recognises london', () => {
    assert.deepEqual(extractLocations('who do i know in london'), ['london']);
});

test('[NetworkQuery]: extractLocations — recognises nyc alias', () => {
    assert.deepEqual(extractLocations('investors in nyc'), ['new york']);
});

test('[NetworkQuery]: extractLocations — recognises sf alias', () => {
    const locs = extractLocations('founders in sf');
    assert.ok(locs.includes('san francisco'));
});

test('[NetworkQuery]: extractLocations — handles multiple cities', () => {
    const locs = extractLocations('people in london and new york');
    assert.ok(locs.includes('london'));
    assert.ok(locs.includes('new york'));
});

test('[NetworkQuery]: extractLocations — empty for no city', () => {
    assert.deepEqual(extractLocations('who are the best engineers'), []);
});

test('[NetworkQuery]: extractLocations — word boundary: india not in indiana', () => {
    // "indiana" contains "india" but should not match "india" due to word boundary check
    const locs = extractLocations('contacts at indiana university');
    assert.ok(!locs.includes('india'), 'should not match india inside indiana');
});

test('[NetworkQuery]: extractLocations — recognises uk country-level', () => {
    const locs = extractLocations('founders in the uk');
    assert.ok(locs.includes('uk'));
});

// ---------------------------------------------------------------------------
// extractRoles
// ---------------------------------------------------------------------------

test('[NetworkQuery]: extractRoles — founder', () => {
    const roles = extractRoles('who are the founders i know');
    assert.ok(roles.includes('founder'));
});

test('[NetworkQuery]: extractRoles — investor via vc keyword', () => {
    const roles = extractRoles('vc and angel investors in my network');
    assert.ok(roles.includes('investor'));
});

test('[NetworkQuery]: extractRoles — engineer via cto', () => {
    const roles = extractRoles('cto connections worth meeting');
    assert.ok(roles.includes('engineer'));
});

test('[NetworkQuery]: extractRoles — consultant via mckinsey', () => {
    const roles = extractRoles('people from mckinsey');
    assert.ok(roles.includes('consultant'));
});

test('[NetworkQuery]: extractRoles — empty for generic query', () => {
    const roles = extractRoles('who do i know in london');
    assert.deepEqual(roles, []);
});

test('[NetworkQuery]: extractRoles — multiple roles', () => {
    const roles = extractRoles('founders and investors in fintech');
    assert.ok(roles.includes('founder'));
    assert.ok(roles.includes('investor'));
});

// ---------------------------------------------------------------------------
// extractIntent
// ---------------------------------------------------------------------------

test('[NetworkQuery]: extractIntent — meet intent', () => {
    assert.equal(extractIntent("who should i meet in london"), 'meet');
});

test('[NetworkQuery]: extractIntent — reconnect intent', () => {
    assert.equal(extractIntent("investors i haven't spoken to in months"), 'reconnect');
});

test('[NetworkQuery]: extractIntent — intro intent', () => {
    assert.equal(extractIntent('can you intro me to a cto'), 'intro');
});

test('[NetworkQuery]: extractIntent — find intent via who do i know', () => {
    assert.equal(extractIntent('who do i know in berlin'), 'find');
});

test('[NetworkQuery]: extractIntent — defaults to find', () => {
    assert.equal(extractIntent('london founders'), 'find');
});

// ---------------------------------------------------------------------------
// parseQuery — integration
// ---------------------------------------------------------------------------

test('[NetworkQuery]: parseQuery — full query parsing', () => {
    const result = parseQuery("who do i know in London that is a founder i should meet?");
    assert.ok(result.locations.includes('london'), `locations: ${JSON.stringify(result.locations)}`);
    assert.ok(result.roles.includes('founder'), `roles: ${JSON.stringify(result.roles)}`);
    assert.equal(result.intent, 'meet');
    assert.equal(result.raw, "who do i know in London that is a founder i should meet?");
});

test('[NetworkQuery]: parseQuery — empty query returns defaults', () => {
    const result = parseQuery('');
    assert.deepEqual(result.locations, []);
    assert.deepEqual(result.roles, []);
    assert.equal(result.intent, 'find');
});

test('[NetworkQuery]: parseQuery — null query returns defaults', () => {
    const result = parseQuery(null);
    assert.deepEqual(result.locations, []);
    assert.deepEqual(result.roles, []);
    assert.equal(result.intent, 'find');
});

// ---------------------------------------------------------------------------
// getSeniorityTier
// ---------------------------------------------------------------------------

test('[NetworkQuery]: getSeniorityTier — ceo is c-suite', () => {
    const { tier, rank } = getSeniorityTier('CEO at Acme');
    assert.equal(tier, 'c-suite');
    assert.equal(rank, 5);
});

test('[NetworkQuery]: getSeniorityTier — founder is c-suite', () => {
    const { tier } = getSeniorityTier('Co-Founder & CTO');
    assert.equal(tier, 'c-suite');
});

test('[NetworkQuery]: getSeniorityTier — vp is vp tier', () => {
    const { tier, rank } = getSeniorityTier('VP Engineering');
    assert.equal(tier, 'vp');
    assert.equal(rank, 4);
});

test('[NetworkQuery]: getSeniorityTier — director tier', () => {
    const { tier } = getSeniorityTier('Director of Product');
    assert.equal(tier, 'director');
});

test('[NetworkQuery]: getSeniorityTier — no title defaults to ic', () => {
    const { tier, rank } = getSeniorityTier(null);
    assert.equal(tier, 'ic');
    assert.equal(rank, 1);
});

// ---------------------------------------------------------------------------
// getRolesFromTitle
// ---------------------------------------------------------------------------

test('[NetworkQuery]: getRolesFromTitle — founder title', () => {
    const roles = getRolesFromTitle('Co-Founder');
    assert.ok(roles.includes('founder'));
});

test('[NetworkQuery]: getRolesFromTitle — multiple roles from title', () => {
    const roles = getRolesFromTitle('Founder & CEO');
    assert.ok(roles.includes('founder'));
    assert.ok(roles.includes('operator'));
});

test('[NetworkQuery]: getRolesFromTitle — empty for null', () => {
    assert.deepEqual(getRolesFromTitle(null), []);
});

// ---------------------------------------------------------------------------
// normalizeLocation
// ---------------------------------------------------------------------------

test('[NetworkQuery]: normalizeLocation — full location string', () => {
    const loc = normalizeLocation('London, England, United Kingdom');
    assert.equal(loc, 'london');
});

test('[NetworkQuery]: normalizeLocation — nyc alias', () => {
    const loc = normalizeLocation('New York, NY, United States');
    assert.equal(loc, 'new york');
});

test('[NetworkQuery]: normalizeLocation — null for no match', () => {
    assert.equal(normalizeLocation(''), null);
    assert.equal(normalizeLocation(null), null);
});

// ---------------------------------------------------------------------------
// buildMeetScore
// ---------------------------------------------------------------------------

test('[NetworkQuery]: buildMeetScore — high score for senior + dormant + strong', () => {
    const score = buildMeetScore({ relationshipScore: 80, daysSinceContact: 90, title: 'CEO' });
    // 80*0.5 + 100*0.3 + 100*0.2 = 40 + 30 + 20 = 90
    assert.equal(score, 90);
});

test('[NetworkQuery]: buildMeetScore — zero relationship score', () => {
    const score = buildMeetScore({ relationshipScore: 0, daysSinceContact: 100, title: 'CEO' });
    // 0*0.5 + 100*0.3 + 100*0.2 = 0 + 30 + 20 = 50
    assert.equal(score, 50);
});

test('[NetworkQuery]: buildMeetScore — recent contact reduces recency penalty', () => {
    const score = buildMeetScore({ relationshipScore: 80, daysSinceContact: 5, title: 'CEO' });
    // 80*0.5 + 100*0.3 + 0*0.2 = 40 + 30 + 0 = 70
    assert.equal(score, 70);
});

test('[NetworkQuery]: buildMeetScore — null daysSince treated as 50 penalty', () => {
    const score = buildMeetScore({ relationshipScore: 0, daysSinceContact: null, title: '' });
    // 0*0.5 + 20*0.3 + 50*0.2 = 0 + 6 + 10 = 16
    assert.equal(score, 16);
});

// ---------------------------------------------------------------------------
// filterIndex
// ---------------------------------------------------------------------------

const SAMPLE_INDEX = [
    { id: 'c1', name: 'Alice Founder', city: 'london', roles: ['founder'], seniority: 'c-suite', seniority_rank: 5, relationshipScore: 80, daysSinceContact: 90, meetScore: 85 },
    { id: 'c2', name: 'Bob Investor', city: 'new york', roles: ['investor'], seniority: 'vp', seniority_rank: 4, relationshipScore: 60, daysSinceContact: 30, meetScore: 60 },
    { id: 'c3', name: 'Carol Engineer', city: 'london', roles: ['engineer'], seniority: 'ic', seniority_rank: 1, relationshipScore: 70, daysSinceContact: 10, meetScore: 45 },
    { id: 'c4', name: 'Dave Director', city: 'berlin', roles: ['operator'], seniority: 'director', seniority_rank: 3, relationshipScore: 50, daysSinceContact: 200, meetScore: 55 },
];

test('[NetworkQuery]: filterIndex — filters by location', () => {
    const parsed = { locations: ['london'], roles: [], intent: 'find' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    assert.ok(results.every(r => r.city === 'london'));
    assert.equal(results.length, 2);
});

test('[NetworkQuery]: filterIndex — filters by role', () => {
    const parsed = { locations: [], roles: ['founder'], intent: 'find' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    assert.ok(results.every(r => r.roles.includes('founder')));
    assert.equal(results.length, 1);
});

test('[NetworkQuery]: filterIndex — filters by location AND role', () => {
    const parsed = { locations: ['london'], roles: ['founder'], intent: 'find' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'c1');
});

test('[NetworkQuery]: filterIndex — meet intent sorts by meetScore', () => {
    const parsed = { locations: [], roles: [], intent: 'meet' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].meetScore >= results[i].meetScore);
    }
});

test('[NetworkQuery]: filterIndex — reconnect intent sorts by daysSinceContact desc', () => {
    const parsed = { locations: [], roles: [], intent: 'reconnect' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    for (let i = 1; i < results.length; i++) {
        assert.ok((results[i - 1].daysSinceContact || 0) >= (results[i].daysSinceContact || 0));
    }
});

test('[NetworkQuery]: filterIndex — returns at most 20 results', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
        id: `c${i}`, name: `Person ${i}`, city: 'london', roles: [],
        seniority: 'ic', seniority_rank: 1, relationshipScore: i,
        daysSinceContact: i, meetScore: i,
    }));
    const parsed = { locations: [], roles: [], intent: 'find' };
    const results = filterIndex(big, parsed);
    assert.equal(results.length, 20);
});

test('[NetworkQuery]: filterIndex — no location/role filter returns all (up to 20)', () => {
    const parsed = { locations: [], roles: [], intent: 'find' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    assert.equal(results.length, SAMPLE_INDEX.length);
});

// ---------------------------------------------------------------------------
// buildIndexEntry
// ---------------------------------------------------------------------------

test('[NetworkQuery]: buildIndexEntry — extracts from apollo location', () => {
    const contact = {
        id: 'c1', name: 'Alice', isGroup: false,
        apollo: { location: 'London, England, United Kingdom', headline: 'CEO at Acme' },
        sources: { linkedin: null },
        relationshipScore: 75, daysSinceContact: 90, interactionCount: 10,
    };
    const entry = buildIndexEntry(contact);
    assert.equal(entry.city, 'london');
    assert.equal(entry.seniority, 'c-suite');
    assert.ok(entry.meetScore > 0);
});

test('[NetworkQuery]: buildIndexEntry — fallback to linkedin position', () => {
    const contact = {
        id: 'c2', name: 'Bob',
        apollo: null,
        sources: { linkedin: { position: 'VP Engineering', company: 'Tech Co', location: 'New York, NY' } },
        relationshipScore: 50, daysSinceContact: 45, interactionCount: 5,
    };
    const entry = buildIndexEntry(contact);
    assert.equal(entry.title, 'VP Engineering');
    assert.equal(entry.company, 'Tech Co');
    assert.equal(entry.city, 'new york');
    assert.equal(entry.seniority, 'vp');
});

// ---------------------------------------------------------------------------
// describeQuery
// ---------------------------------------------------------------------------

test('[NetworkQuery]: describeQuery — full parsed query', () => {
    const parsed = { locations: ['london'], roles: ['founder'], intent: 'meet' };
    const desc = describeQuery(parsed);
    assert.ok(desc.includes('London'));
    assert.ok(desc.includes('founder'));
    assert.ok(desc.includes('meet'));
});

test('[NetworkQuery]: describeQuery — no filters', () => {
    const parsed = { locations: [], roles: [], intent: 'find' };
    const desc = describeQuery(parsed);
    assert.ok(typeof desc === 'string' && desc.length > 0);
});
