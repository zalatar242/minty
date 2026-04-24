/**
 * crm/life-events.js — detect life events from unified contact data.
 *
 * Minty runs offline, so we can't poll external feeds. But we have rich
 * conversation + metadata history locally — enough to catch most of the
 * events a user would want to react to:
 *
 *   - job_change     : new role announcements, "joining <company>"
 *   - funding        : raising-a-round announcements
 *   - milestone      : launches, IPO, acquisition, promotion
 *   - life_moment    : engagement, wedding, baby, move, graduation
 *   - birthday       : from Google Contacts BDAY field (upcoming within 14d)
 *   - reconnection   : "great catching up" / "first time in a while"
 *
 * Each detected event has:
 *   { kind, label, evidence, contactId, contactName, timestamp, source, snippet }
 *
 * Pure functions only. Callers supply contacts, interactions, and "now".
 */

'use strict';

const EVENT_PATTERNS = [
    {
        kind: 'job_change',
        label: 'New role',
        regex: /\b(joining|joined|started at|just started|new role|new gig|moved to|excited to announce (?:i('m| am)|that i('m| am)))\b/i,
        weight: 5,
    },
    {
        kind: 'job_change',
        label: 'Promotion',
        regex: /\b(promoted to|promotion to|got promoted|stepping up to|took over as)\b/i,
        weight: 4,
    },
    {
        kind: 'funding',
        label: 'Fundraise',
        regex: /\b(raised|raising|closed|closing)\b.{0,30}\b(seed|series [a-d]|round|pre-seed|million|bridge)\b/i,
        weight: 6,
    },
    {
        kind: 'milestone',
        label: 'Launch',
        regex: /\b(just (launched|shipped|went live)|product hunt|launch day|publicly live)\b/i,
        weight: 4,
    },
    {
        kind: 'milestone',
        label: 'Acquisition',
        regex: /\b(acquired by|acquiring|got acquired|we('re| are) joining)\b/i,
        weight: 6,
    },
    {
        kind: 'life_moment',
        label: 'Life event',
        regex: /\b(engaged|got engaged|getting married|just married|we('re| are) expecting|had a baby|welcomed .* baby)\b/i,
        weight: 5,
    },
    {
        kind: 'life_moment',
        label: 'Location move',
        regex: /\b(moved to|moving to|relocating to|settled in|back in)\b\s+[A-Z][a-z]/,
        weight: 3,
    },
    {
        kind: 'reconnection',
        label: 'Back in touch',
        regex: /\b(great to (catch up|reconnect|see you again)|been a (while|minute)|long time (no (see|chat)|since))\b/i,
        weight: 2,
    },
];

function isSelf(from) {
    return from === 'me' || from === 'Me';
}

/**
 * Scan this contact's interactions for announcement-style content.
 * Only considers messages NOT from the user (we care about things *they* told us).
 */
function detectAnnouncementEvents(contact, interactions, opts = {}) {
    const recent = opts.recentDays != null ? opts.recentDays : 180;
    const now = opts.now || Date.now();
    const floor = now - recent * 86400000;

    const out = [];
    for (const i of interactions || []) {
        if (!i.timestamp) continue;
        const t = new Date(i.timestamp).getTime();
        if (isNaN(t) || t < floor) continue;
        if (isSelf(i.from)) continue;
        const text = ((i.body || '') + ' ' + (i.subject || '')).trim();
        if (text.length < 5) continue;

        for (const p of EVENT_PATTERNS) {
            const m = text.match(p.regex);
            if (!m) continue;
            out.push({
                kind: p.kind,
                label: p.label,
                evidence: m[0],
                source: i.source,
                timestamp: i.timestamp,
                snippet: snippet(text, m.index, m[0].length),
                weight: p.weight,
                contactId: contact.id,
                contactName: contact.name || null,
            });
            break; // one signal per message is plenty
        }
    }
    return out;
}

/**
 * Birthday from Google Contacts BDAY field. Returns an event if the
 * birthday is within the next N days (default 14).
 */
function detectBirthday(contact, opts = {}) {
    const within = opts.within != null ? opts.within : 14;
    const now = opts.now ? new Date(opts.now) : new Date();
    const raw = contact.sources?.googleContacts?.birthday;
    if (!raw) return null;

    // Accept formats like "1990-03-15", "--03-15", or "03-15"
    const m = String(raw).match(/(\d{4})?-?(\d{2})-(\d{2})/);
    if (!m) return null;
    const month = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    if (isNaN(month) || isNaN(day)) return null;

    let next = new Date(now.getFullYear(), month, day);
    if (next.getTime() < now.getTime()) {
        next = new Date(now.getFullYear() + 1, month, day);
    }
    const daysAway = Math.floor((next.getTime() - now.getTime()) / 86400000);
    if (daysAway > within) return null;

    return {
        kind: 'birthday',
        label: daysAway === 0 ? 'Birthday today' :
               daysAway === 1 ? 'Birthday tomorrow' : 'Birthday in ' + daysAway + ' days',
        evidence: raw,
        source: 'googleContacts',
        timestamp: next.toISOString(),
        snippet: null,
        weight: 4,
        contactId: contact.id,
        contactName: contact.name || null,
        daysAway,
    };
}

/**
 * Detect a LinkedIn-reported job change by comparing the contact's current
 * LinkedIn position with the most recent Apollo employment entry.
 * A "change" is when the Apollo headline lists a company that differs
 * from the LinkedIn company.
 */
function detectJobChange(contact) {
    const liCompany = contact.sources?.linkedin?.company;
    const liPosition = contact.sources?.linkedin?.position;
    const apolloOrg = contact.apollo?.employmentHistory?.[0]?.organization_name;
    const apolloTitle = contact.apollo?.employmentHistory?.[0]?.title;
    if (!liCompany || !apolloOrg) return null;
    if (normalize(liCompany) === normalize(apolloOrg)) return null;

    return {
        kind: 'job_change',
        label: 'Moved ' + apolloOrg + ' → ' + liCompany,
        evidence: (apolloTitle || '') + ' @ ' + apolloOrg + ' → ' + (liPosition || '') + ' @ ' + liCompany,
        source: 'linkedin',
        timestamp: null,
        snippet: null,
        weight: 5,
        contactId: contact.id,
        contactName: contact.name || null,
    };
}

function normalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function snippet(text, start, length) {
    const winBefore = Math.max(0, start - 30);
    const winAfter = Math.min(text.length, start + length + 60);
    return (winBefore > 0 ? '…' : '') + text.slice(winBefore, winAfter) + (winAfter < text.length ? '…' : '');
}

/**
 * Full sweep: detect life events for every contact + interaction.
 * `interactionsByContactId` is a map keyed by contact.id.
 * Returns events sorted newest-first.
 */
function detectAllEvents({ contacts, interactionsByContactId, now = Date.now() }) {
    const events = [];
    for (const c of contacts || []) {
        if (!c || c.isGroup) continue;
        const list = (interactionsByContactId && interactionsByContactId[c.id]) || [];
        events.push(...detectAnnouncementEvents(c, list, { now }));
        const bday = detectBirthday(c, { now });
        if (bday) events.push(bday);
        const job = detectJobChange(c);
        if (job) events.push(job);
    }
    return rankEvents(events);
}

function rankEvents(events) {
    // Sort by (weight * recency) descending, newest first.
    return events
        .slice()
        .sort((a, b) => {
            const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            // Score: weight * (1 / (1 + daysAgo/30))
            const now = Date.now();
            const sa = (a.weight || 1) * (1 / (1 + Math.max(0, (now - ta) / 86400000) / 30));
            const sb = (b.weight || 1) * (1 / (1 + Math.max(0, (now - tb) / 86400000) / 30));
            return sb - sa;
        });
}

module.exports = {
    EVENT_PATTERNS,
    detectAnnouncementEvents,
    detectBirthday,
    detectJobChange,
    detectAllEvents,
    rankEvents,
};
