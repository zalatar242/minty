/**
 * tests/unit/calendar.test.js — unit tests for crm/calendar.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    extractAttendees,
    buildEmailIndex,
    enrichAttendees,
    buildMeetingData,
    processMeetings,
    isMeetingToday,
    sortMeetings,
} = require('../../crm/calendar');

// ---------------------------------------------------------------------------
// extractAttendees
// ---------------------------------------------------------------------------

test('[Calendar]: extractAttendees returns empty array for null event', () => {
    assert.deepEqual(extractAttendees(null), []);
});

test('[Calendar]: extractAttendees returns empty array for event with no attendees', () => {
    assert.deepEqual(extractAttendees({}), []);
    assert.deepEqual(extractAttendees({ attendees: [] }), []);
});

test('[Calendar]: extractAttendees extracts email and displayName', () => {
    const event = {
        attendees: [
            { email: 'Sarah@Example.com', displayName: 'Sarah Chen', responseStatus: 'accepted' },
            { email: 'bob@test.com', responseStatus: 'tentative' },
        ],
    };
    const result = extractAttendees(event);
    assert.equal(result.length, 2);
    assert.equal(result[0].email, 'sarah@example.com');
    assert.equal(result[0].displayName, 'Sarah Chen');
    assert.equal(result[0].responseStatus, 'accepted');
    assert.equal(result[1].email, 'bob@test.com');
    assert.equal(result[1].displayName, null);
});

test('[Calendar]: extractAttendees filters out invalid emails', () => {
    const event = {
        attendees: [
            { email: 'valid@example.com' },
            { email: '' },
            { email: null },
            { email: 'notanemail' },
        ],
    };
    const result = extractAttendees(event);
    assert.equal(result.length, 1);
    assert.equal(result[0].email, 'valid@example.com');
});

test('[Calendar]: extractAttendees lowercases and trims email', () => {
    const event = { attendees: [{ email: '  Test@EXAMPLE.COM  ' }] };
    const result = extractAttendees(event);
    assert.equal(result[0].email, 'test@example.com');
});

test('[Calendar]: extractAttendees sets self flag correctly', () => {
    const event = {
        attendees: [
            { email: 'me@example.com', self: true },
            { email: 'them@example.com', self: false },
        ],
    };
    const result = extractAttendees(event);
    assert.equal(result[0].self, true);
    assert.equal(result[1].self, false);
});

test('[Calendar]: extractAttendees defaults responseStatus to needsAction', () => {
    const event = { attendees: [{ email: 'a@b.com' }] };
    const result = extractAttendees(event);
    assert.equal(result[0].responseStatus, 'needsAction');
});

// ---------------------------------------------------------------------------
// buildEmailIndex
// ---------------------------------------------------------------------------

test('[Calendar]: buildEmailIndex returns empty Map for empty contacts', () => {
    const idx = buildEmailIndex([]);
    assert.equal(idx.size, 0);
});

test('[Calendar]: buildEmailIndex indexes contacts by email', () => {
    const contacts = [
        { id: 'c_001', name: 'Alice', emails: [{ email: 'alice@example.com' }], isGroup: false },
        { id: 'c_002', name: 'Bob',   emails: [{ email: 'BOB@EXAMPLE.COM' }],   isGroup: false },
    ];
    const idx = buildEmailIndex(contacts);
    assert.ok(idx.has('alice@example.com'));
    assert.ok(idx.has('bob@example.com'));
    assert.equal(idx.get('alice@example.com').id, 'c_001');
});

test('[Calendar]: buildEmailIndex skips group contacts', () => {
    const contacts = [
        { id: 'g_001', name: 'Team Chat', emails: [{ email: 'team@example.com' }], isGroup: true },
        { id: 'c_001', name: 'Alice',     emails: [{ email: 'alice@example.com' }], isGroup: false },
    ];
    const idx = buildEmailIndex(contacts);
    assert.ok(!idx.has('team@example.com'));
    assert.ok(idx.has('alice@example.com'));
});

test('[Calendar]: buildEmailIndex handles contacts with no emails', () => {
    const contacts = [{ id: 'c_001', name: 'Alice', emails: [], isGroup: false }];
    const idx = buildEmailIndex(contacts);
    assert.equal(idx.size, 0);
});

test('[Calendar]: buildEmailIndex handles multiple emails per contact', () => {
    const contacts = [
        {
            id: 'c_001', name: 'Alice', isGroup: false,
            emails: [{ email: 'alice@work.com' }, { email: 'alice@personal.com' }],
        },
    ];
    const idx = buildEmailIndex(contacts);
    assert.ok(idx.has('alice@work.com'));
    assert.ok(idx.has('alice@personal.com'));
    assert.equal(idx.get('alice@work.com').id, 'c_001');
});

// ---------------------------------------------------------------------------
// enrichAttendees
// ---------------------------------------------------------------------------

test('[Calendar]: enrichAttendees returns contactId null for unknown attendee', () => {
    const emailIndex = buildEmailIndex([]);
    const attendees = [{ email: 'unknown@example.com', displayName: 'Unknown', self: false, responseStatus: 'accepted' }];
    const result = enrichAttendees(attendees, emailIndex, {});
    assert.equal(result[0].contactId, null);
    assert.equal(result[0].name, 'Unknown');
});

test('[Calendar]: enrichAttendees enriches matched contact', () => {
    const contacts = [{ id: 'c_001', name: 'Alice', emails: [{ email: 'alice@example.com' }],
        isGroup: false, relationshipScore: 75, lastContactedAt: '2026-01-01T00:00:00Z', daysSinceContact: 73 }];
    const emailIndex = buildEmailIndex(contacts);
    const insights = { c_001: { topics: ['AI', 'startups'], openLoops: ['intro request'], meetingBrief: 'Alice is a founder.' } };
    const attendees = [{ email: 'alice@example.com', displayName: 'A', self: false, responseStatus: 'accepted' }];

    const result = enrichAttendees(attendees, emailIndex, insights);
    assert.equal(result[0].contactId, 'c_001');
    assert.equal(result[0].name, 'Alice');
    assert.equal(result[0].relationshipScore, 75);
    assert.equal(result[0].daysSinceContact, 73);
    assert.deepEqual(result[0].topics, ['AI', 'startups']);
    assert.equal(result[0].meetingBrief, 'Alice is a founder.');
});

test('[Calendar]: enrichAttendees handles missing insights gracefully', () => {
    const contacts = [{ id: 'c_001', name: 'Alice', emails: [{ email: 'alice@example.com' }], isGroup: false }];
    const emailIndex = buildEmailIndex(contacts);
    const attendees = [{ email: 'alice@example.com', displayName: null, self: false, responseStatus: 'accepted' }];

    const result = enrichAttendees(attendees, emailIndex, {});
    assert.equal(result[0].contactId, 'c_001');
    assert.deepEqual(result[0].topics, []);
    assert.equal(result[0].meetingBrief, null);
});

// ---------------------------------------------------------------------------
// buildMeetingData
// ---------------------------------------------------------------------------

test('[Calendar]: buildMeetingData builds correct shape', () => {
    const event = {
        id: 'evt_001',
        summary: 'Coffee with Alice',
        start: { dateTime: '2026-03-20T10:00:00Z' },
        end:   { dateTime: '2026-03-20T11:00:00Z' },
        location: 'Zoom',
    };
    const enriched = [{ email: 'alice@example.com', contactId: 'c_001', name: 'Alice' }];
    const meeting = buildMeetingData(event, enriched);

    assert.equal(meeting.id, 'evt_001');
    assert.equal(meeting.title, 'Coffee with Alice');
    assert.equal(meeting.startAt, '2026-03-20T10:00:00Z');
    assert.equal(meeting.endAt, '2026-03-20T11:00:00Z');
    assert.equal(meeting.location, 'Zoom');
    assert.equal(meeting.attendees.length, 1);
});

test('[Calendar]: buildMeetingData uses "(No title)" when summary missing', () => {
    const event = { id: 'e1', start: { dateTime: '2026-03-20T10:00:00Z' }, end: { dateTime: '2026-03-20T11:00:00Z' } };
    const meeting = buildMeetingData(event, []);
    assert.equal(meeting.title, '(No title)');
});

test('[Calendar]: buildMeetingData falls back to date when dateTime missing', () => {
    const event = { id: 'e2', summary: 'All-day', start: { date: '2026-03-20' }, end: { date: '2026-03-21' } };
    const meeting = buildMeetingData(event, []);
    assert.equal(meeting.startAt, '2026-03-20');
    assert.equal(meeting.endAt, '2026-03-21');
});

// ---------------------------------------------------------------------------
// processMeetings
// ---------------------------------------------------------------------------

test('[Calendar]: processMeetings returns empty for empty input', () => {
    assert.deepEqual(processMeetings([], [], {}), []);
});

test('[Calendar]: processMeetings filters out invalid events', () => {
    const events = [null, undefined, {}, { id: 'valid', summary: 'OK', start: { dateTime: '2026-03-20T10:00:00Z' }, end: { dateTime: '2026-03-20T11:00:00Z' } }];
    const result = processMeetings(events, [], {});
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'valid');
});

test('[Calendar]: processMeetings enriches attendees from contacts', () => {
    const contacts = [{ id: 'c_001', name: 'Alice', emails: [{ email: 'alice@example.com' }], isGroup: false, relationshipScore: 60 }];
    const events = [{
        id: 'e1', summary: 'Meeting', start: { dateTime: '2026-03-20T10:00:00Z' }, end: { dateTime: '2026-03-20T11:00:00Z' },
        attendees: [{ email: 'alice@example.com', displayName: 'Alice' }],
    }];
    const result = processMeetings(events, contacts, {});
    assert.equal(result[0].attendees[0].contactId, 'c_001');
    assert.equal(result[0].attendees[0].relationshipScore, 60);
});

// ---------------------------------------------------------------------------
// isMeetingToday
// ---------------------------------------------------------------------------

test('[Calendar]: isMeetingToday returns false for null startAt', () => {
    assert.equal(isMeetingToday({ startAt: null }), false);
});

test('[Calendar]: isMeetingToday returns true for today', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(isMeetingToday({ startAt: today + 'T10:00:00Z' }), true);
});

test('[Calendar]: isMeetingToday returns false for tomorrow', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.equal(isMeetingToday({ startAt: tomorrow + 'T10:00:00Z' }), false);
});

// ---------------------------------------------------------------------------
// sortMeetings
// ---------------------------------------------------------------------------

test('[Calendar]: sortMeetings sorts ascending by startAt', () => {
    const meetings = [
        { id: 'b', startAt: '2026-03-20T14:00:00Z' },
        { id: 'a', startAt: '2026-03-20T09:00:00Z' },
        { id: 'c', startAt: '2026-03-21T09:00:00Z' },
    ];
    const sorted = sortMeetings(meetings);
    assert.equal(sorted[0].id, 'a');
    assert.equal(sorted[1].id, 'b');
    assert.equal(sorted[2].id, 'c');
});

test('[Calendar]: sortMeetings puts null startAt last', () => {
    const meetings = [
        { id: 'b', startAt: null },
        { id: 'a', startAt: '2026-03-20T09:00:00Z' },
    ];
    const sorted = sortMeetings(meetings);
    assert.equal(sorted[0].id, 'a');
    assert.equal(sorted[1].id, 'b');
});

test('[Calendar]: sortMeetings does not mutate input array', () => {
    const meetings = [
        { id: 'b', startAt: '2026-03-20T14:00:00Z' },
        { id: 'a', startAt: '2026-03-20T09:00:00Z' },
    ];
    const original = [...meetings];
    sortMeetings(meetings);
    assert.equal(meetings[0].id, original[0].id);
});
