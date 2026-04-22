/**
 * crm/calendar.js — Google Calendar integration
 *
 * Pure functions for fetching, parsing, and cross-referencing
 * calendar events with the contacts database.
 *
 * Called from:
 *   - crm/sync.js: background polling (every 15 min)
 *   - crm/server.js: GET /api/calendar/upcoming
 */

'use strict';

const https = require('https');

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extract attendees from a raw Google Calendar event object.
 * Returns an array of { email, displayName, self, responseStatus }.
 * Filters out empty/invalid emails.
 */
function extractAttendees(event) {
    if (!event || !Array.isArray(event.attendees)) return [];
    return event.attendees
        .filter(a => a && typeof a.email === 'string' && a.email.includes('@'))
        .map(a => ({
            email:          a.email.toLowerCase().trim(),
            displayName:    a.displayName || null,
            self:           a.self === true,
            responseStatus: a.responseStatus || 'needsAction',
        }));
}

/**
 * Cross-reference a list of attendee emails against the contacts array.
 * Returns a Map of email -> contactId for matched contacts.
 * Matching is case-insensitive on contact.emails[].email.
 */
function buildEmailIndex(contacts) {
    const index = new Map(); // email -> contact
    for (const c of (contacts || [])) {
        if (c.isGroup) continue;
        for (const e of (c.emails || [])) {
            if (e && e.email) {
                index.set(e.email.toLowerCase().trim(), c);
            }
        }
    }
    return index;
}

/**
 * Enrich a list of attendees with contact data from contacts array.
 * Returns enriched attendees: { email, displayName, self, responseStatus,
 *   contactId, name, relationshipScore, lastContactedAt, daysSinceContact,
 *   topics, openLoops, meetingBrief }
 */
function enrichAttendees(attendees, emailIndex, insights) {
    return attendees.map(a => {
        const contact = emailIndex.get(a.email);
        if (!contact) {
            return { ...a, contactId: null, name: a.displayName, relationshipScore: null,
                lastContactedAt: null, daysSinceContact: null, topics: [], openLoops: [], meetingBrief: null };
        }
        const ins = (insights || {})[contact.id] || null;
        return {
            ...a,
            contactId:         contact.id,
            name:              contact.name || a.displayName,
            relationshipScore: contact.relationshipScore || 0,
            lastContactedAt:   contact.lastContactedAt || null,
            daysSinceContact:  contact.daysSinceContact || null,
            topics:            ins ? (ins.topics || []) : [],
            openLoops:         ins ? (ins.openLoops || []) : [],
            meetingBrief:      ins ? (ins.meetingBrief || null) : null,
        };
    });
}

/**
 * Build a meeting data object from a raw Google Calendar event and enriched attendees.
 * Shape matches the PRD spec.
 */
function buildMeetingData(event, enrichedAttendees) {
    const start = event.start?.dateTime || event.start?.date || null;
    const end   = event.end?.dateTime   || event.end?.date   || null;
    return {
        id:        event.id,
        title:     event.summary || '(No title)',
        startAt:   start,
        endAt:     end,
        location:  event.location || null,
        attendees: enrichedAttendees,
    };
}

/**
 * Process a raw list of Google Calendar events into meeting data objects.
 * Filters out events with no human attendees (solo events / all-day blockers).
 * contacts and insights are optional — pass null to skip enrichment.
 */
function processMeetings(rawEvents, contacts, insights) {
    const emailIndex = buildEmailIndex(contacts || []);
    return rawEvents
        .filter(e => e && e.id)
        .map(e => {
            const attendees = extractAttendees(e);
            const enriched  = enrichAttendees(attendees, emailIndex, insights || {});
            return buildMeetingData(e, enriched);
        });
}

/**
 * Returns true if a meeting is happening today (UTC date match).
 */
function isMeetingToday(meeting) {
    if (!meeting.startAt) return false;
    const today = new Date().toISOString().slice(0, 10);
    return meeting.startAt.slice(0, 10) === today;
}

/**
 * Sort meetings by startAt ascending.
 */
function sortMeetings(meetings) {
    return [...meetings].sort((a, b) => {
        if (!a.startAt) return 1;
        if (!b.startAt) return -1;
        return a.startAt.localeCompare(b.startAt);
    });
}

// ---------------------------------------------------------------------------
// Network helper
// ---------------------------------------------------------------------------

/**
 * Make a GET request to the Google Calendar API.
 * Returns parsed JSON or throws on error.
 */
function calendarGet(accessToken, endpoint) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname: 'www.googleapis.com',
            path:     '/calendar/v3/' + endpoint,
            headers:  { Authorization: 'Bearer ' + accessToken },
        }, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Bad JSON from Calendar API: ' + body.slice(0, 200))); }
            });
        }).on('error', reject);
    });
}

/**
 * Fetch Google Calendar events for the next N days.
 * timeMin defaults to now; timeMax defaults to now + 7 days.
 * Returns raw event list (array).
 */
async function fetchCalendarEvents(accessToken, options) {
    const now = new Date();
    const timeMin = options?.timeMin || now.toISOString();
    const timeMax = options?.timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const maxResults = options?.maxResults || 50;

    const qs = new URLSearchParams({
        calendarId:   'primary',
        timeMin,
        timeMax,
        maxResults:   String(maxResults),
        singleEvents: 'true',
        orderBy:      'startTime',
    });

    const data = await calendarGet(accessToken, `calendars/primary/events?${qs}`);

    if (data.error) {
        const err = new Error('Calendar API error: ' + JSON.stringify(data.error));
        err.status = data.error.code;
        throw err;
    }

    return data.items || [];
}

module.exports = {
    extractAttendees,
    buildEmailIndex,
    enrichAttendees,
    buildMeetingData,
    processMeetings,
    isMeetingToday,
    sortMeetings,
    calendarGet,
    fetchCalendarEvents,
};
