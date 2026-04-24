/**
 * tests/unit/people-graph.test.js — pure-function tests for crm/people-graph.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    groupEdgeWeight,
    getSharedGroups,
    findIntroPaths,
    computeGroupSignalScores,
    buildWarmIntroBriefs,
} = require('../../crm/people-graph');

// ---------------------------------------------------------------------------
// groupEdgeWeight
// ---------------------------------------------------------------------------

test('[PeopleGraph]: groupEdgeWeight — 2-person group > 100-person group', () => {
    assert.ok(groupEdgeWeight(2) > groupEdgeWeight(100));
});

test('[PeopleGraph]: groupEdgeWeight — bounded (0, 1]', () => {
    const w = groupEdgeWeight(2);
    assert.ok(w > 0 && w <= 1);
});

test('[PeopleGraph]: groupEdgeWeight — size 0 treated as smallest (no NaN)', () => {
    const w = groupEdgeWeight(0);
    assert.ok(Number.isFinite(w));
    assert.equal(w, 1); // 1 / log2(2) = 1
});

// ---------------------------------------------------------------------------
// getSharedGroups
// ---------------------------------------------------------------------------

test('[PeopleGraph]: getSharedGroups — returns empty for contact with no groups', () => {
    assert.deepEqual(getSharedGroups({ groupMemberships: [] }, {}), []);
    assert.deepEqual(getSharedGroups({}, {}), []);
    assert.deepEqual(getSharedGroups(null, {}), []);
});

test('[PeopleGraph]: getSharedGroups — enriches with size + sorts smallest-first', () => {
    const contact = {
        groupMemberships: [
            { chatId: 'big@g.us', chatName: 'Big', isAdmin: false },
            { chatId: 'small@g.us', chatName: 'Small', isAdmin: true },
        ],
    };
    const memberships = {
        'big@g.us': { name: 'Big', size: 400 },
        'small@g.us': { name: 'Small', size: 4 },
    };
    const result = getSharedGroups(contact, memberships);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'Small');
    assert.equal(result[0].size, 4);
    assert.equal(result[0].isAdmin, true);
    assert.equal(result[1].name, 'Big');
});

test('[PeopleGraph]: getSharedGroups — skips memberships with no metadata', () => {
    const contact = {
        groupMemberships: [
            { chatId: 'ghost@g.us', chatName: 'Ghost' },
            { chatId: 'real@g.us', chatName: 'Real' },
        ],
    };
    const memberships = { 'real@g.us': { name: 'Real', size: 3 } };
    const result = getSharedGroups(contact, memberships);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Real');
});

// ---------------------------------------------------------------------------
// findIntroPaths
// ---------------------------------------------------------------------------

function fixture() {
    const contacts = [
        { id: 'c_you', name: 'You', relationshipScore: 0, groupMemberships: [
            { chatId: 'a@g.us' }, { chatId: 'b@g.us' }, { chatId: 'big@g.us' }
        ]},
        { id: 'c_target', name: 'Target Person', relationshipScore: 0, groupMemberships: [
            { chatId: 'a@g.us' }, { chatId: 'big@g.us' }
        ]},
        { id: 'c_priya', name: 'Priya', relationshipScore: 80, groupMemberships: [
            { chatId: 'a@g.us' }, { chatId: 'b@g.us' }
        ]},
        { id: 'c_bob', name: 'Bob', relationshipScore: 20, groupMemberships: [
            { chatId: 'big@g.us' }
        ]},
        { id: 'c_anon', name: null, relationshipScore: 0, groupMemberships: [
            { chatId: 'a@g.us' }
        ]},
        { id: 'c_group', name: 'Some Group', isGroup: true, relationshipScore: 0 },
    ];
    const memberships = {
        'a@g.us':   { name: 'SF Pierogi', size: 4, members: ['c_you', 'c_target', 'c_priya', 'c_anon'] },
        'b@g.us':   { name: 'UCL BJJ', size: 8, members: ['c_you', 'c_priya'] },
        'big@g.us': { name: 'Gen Z VC', size: 500, members: ['c_you', 'c_target', 'c_bob'] },
    };
    return { contacts, memberships };
}

test('[PeopleGraph]: findIntroPaths — returns empty for unknown target', () => {
    const { contacts, memberships } = fixture();
    assert.deepEqual(findIntroPaths('nope', contacts, memberships), []);
});

test('[PeopleGraph]: findIntroPaths — top intro is high-score person in small group', () => {
    const { contacts, memberships } = fixture();
    const paths = findIntroPaths('c_target', contacts, memberships, { excludeIds: ['c_you'] });
    assert.ok(paths.length > 0);
    assert.equal(paths[0].intermediaryId, 'c_priya');
    assert.ok(paths[0].sharedGroupsWithTarget.some(g => g.chatId === 'a@g.us'));
});

test('[PeopleGraph]: findIntroPaths — excludes the viewer via excludeIds', () => {
    const { contacts, memberships } = fixture();
    const paths = findIntroPaths('c_target', contacts, memberships, { excludeIds: ['c_you'] });
    assert.ok(paths.every(p => p.intermediaryId !== 'c_you'));
});

test('[PeopleGraph]: findIntroPaths — excludes the target themselves', () => {
    const { contacts, memberships } = fixture();
    const paths = findIntroPaths('c_target', contacts, memberships, { excludeIds: ['c_you'] });
    assert.ok(paths.every(p => p.intermediaryId !== 'c_target'));
});

test('[PeopleGraph]: findIntroPaths — excludes anonymous (nameless) intermediaries', () => {
    const { contacts, memberships } = fixture();
    const paths = findIntroPaths('c_target', contacts, memberships, { excludeIds: ['c_you'] });
    assert.ok(paths.every(p => p.intermediaryId !== 'c_anon'));
});

test('[PeopleGraph]: findIntroPaths — excludes group contacts', () => {
    const { contacts, memberships } = fixture();
    const paths = findIntroPaths('c_target', contacts, memberships, { excludeIds: ['c_you'] });
    assert.ok(paths.every(p => p.intermediaryId !== 'c_group'));
});

test('[PeopleGraph]: findIntroPaths — filters out mega-groups above maxGroupSize', () => {
    const { contacts, memberships } = fixture();
    // Only bob shares with target exclusively through the 500-person mega-group.
    // With default maxGroupSize=200, bob should not appear as an intro candidate.
    const paths = findIntroPaths('c_target', contacts, memberships, { excludeIds: ['c_you'] });
    assert.ok(paths.every(p => p.intermediaryId !== 'c_bob'));
    // Relaxing the cap brings bob back.
    const paths2 = findIntroPaths('c_target', contacts, memberships, { excludeIds: ['c_you'], maxGroupSize: 10000 });
    assert.ok(paths2.some(p => p.intermediaryId === 'c_bob'));
});

test('[PeopleGraph]: findIntroPaths — maxPaths caps the result size', () => {
    const { contacts, memberships } = fixture();
    const paths = findIntroPaths('c_target', contacts, memberships, { excludeIds: ['c_you'], maxPaths: 1 });
    assert.equal(paths.length, 1);
});

// ---------------------------------------------------------------------------
// computeGroupSignalScores
// ---------------------------------------------------------------------------

test('[PeopleGraph]: computeGroupSignalScores — more small-group membership = higher score', () => {
    const { contacts, memberships } = fixture();
    const scores = computeGroupSignalScores(contacts, memberships);
    // Priya is in 2 small groups; Bob is in 1 big group -> Priya > Bob.
    assert.ok(scores['c_priya'] > scores['c_bob']);
});

test('[PeopleGraph]: computeGroupSignalScores — contacts with no memberships are absent', () => {
    const contacts = [{ id: 'c_solo', name: 'Solo', groupMemberships: [] }];
    const scores = computeGroupSignalScores(contacts, {});
    assert.equal(scores['c_solo'], undefined);
});

// ---------------------------------------------------------------------------
// buildWarmIntroBriefs
// ---------------------------------------------------------------------------

test('[PeopleGraph]: buildWarmIntroBriefs — one brief per target with path found', () => {
    const { contacts, memberships } = fixture();
    const targets = [{ id: 'c_target', name: 'Target Person' }];
    const briefs = buildWarmIntroBriefs(targets, contacts, memberships, { excludeIds: ['c_you'] });
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].target.id, 'c_target');
    assert.equal(briefs[0].intermediary.id, 'c_priya');
    assert.ok(briefs[0].sharedGroup);
    assert.equal(briefs[0].sharedGroup.chatId, 'a@g.us');
});

test('[PeopleGraph]: buildWarmIntroBriefs — skips targets with no warm path', () => {
    const contacts = [
        { id: 'c_you', name: 'You', relationshipScore: 0, groupMemberships: [{ chatId: 'x@g.us' }] },
        { id: 'c_alone', name: 'Alone', relationshipScore: 0, groupMemberships: [{ chatId: 'x@g.us' }] },
    ];
    const memberships = { 'x@g.us': { name: 'X', size: 2, members: ['c_you', 'c_alone'] } };
    const briefs = buildWarmIntroBriefs(
        [{ id: 'c_alone', name: 'Alone' }],
        contacts,
        memberships,
        { excludeIds: ['c_you'] }
    );
    // No third party to broker; should be empty.
    assert.equal(briefs.length, 0);
});
