/**
 * crm/meeting-debrief.js — post-meeting debrief logic.
 *
 * Pure functions for:
 *   - identifying meetings that happened in the past N hours and haven't been
 *     debriefed yet (i.e. "did you log the outcome?")
 *   - applying a debrief payload to a store keyed by meetingId
 *   - shaping the store for UI consumption
 *
 * Storage: data/unified/meeting-debriefs.json
 *   {
 *     <meetingId>: {
 *       outcome: string,
 *       actionItems: [{ text, due? }],
 *       stageMoves: [{ contactId, goalId, stage }],
 *       loggedAt: ISO,
 *     }
 *   }
 */

'use strict';

const DEFAULT_LOOKBACK_HOURS = 72;
const DEFAULT_GRACE_MINUTES = 15;  // don't flag a meeting debrief before meeting end+grace

function meetingEndMs(m) {
    if (m.endAt) return new Date(m.endAt).getTime();
    if (m.startAt) {
        const start = new Date(m.startAt).getTime();
        return start + 60 * 60 * 1000; // assume 1 hour
    }
    return null;
}

/**
 * Returns meetings needing a debrief — i.e. ended between `lookbackHours` ago
 * and `graceMinutes` ago, and not yet present in `debriefs`.
 */
function pendingDebriefs(meetings, debriefs = {}, opts = {}) {
    const lookbackHours = opts.lookbackHours != null ? opts.lookbackHours : DEFAULT_LOOKBACK_HOURS;
    const graceMin = opts.graceMinutes != null ? opts.graceMinutes : DEFAULT_GRACE_MINUTES;
    const now = opts.now ? (typeof opts.now === 'number' ? opts.now : new Date(opts.now).getTime()) : Date.now();
    const floor = now - lookbackHours * 3600 * 1000;
    const ceil = now - graceMin * 60 * 1000;

    const out = [];
    for (const m of meetings || []) {
        const end = meetingEndMs(m);
        if (end == null) continue;
        if (end < floor || end > ceil) continue;
        if (m.id && debriefs[m.id]) continue;
        out.push(m);
    }
    return out;
}

/**
 * Apply a debrief payload, returning an updated store.
 * Validates required fields and trims text.
 */
function recordDebrief(debriefs, meetingId, payload) {
    if (!meetingId) throw new Error('meetingId required');
    const outcome = (payload && payload.outcome) || '';
    const actionItems = Array.isArray(payload && payload.actionItems) ? payload.actionItems : [];
    const stageMoves = Array.isArray(payload && payload.stageMoves) ? payload.stageMoves : [];
    const sanitisedActions = actionItems
        .map(a => {
            if (!a) return null;
            if (typeof a === 'string') return { text: a.trim() };
            return { text: String(a.text || '').trim(), due: a.due || null };
        })
        .filter(a => a && a.text);

    const entry = {
        outcome: String(outcome).trim(),
        actionItems: sanitisedActions,
        stageMoves: stageMoves.filter(m => m && m.contactId && m.stage),
        loggedAt: new Date().toISOString(),
    };

    return { ...debriefs, [meetingId]: entry };
}

/**
 * Summarise a single debrief for the UI ("3 action items · 2 stage moves").
 */
function summariseDebrief(entry) {
    if (!entry) return null;
    const parts = [];
    if (entry.actionItems && entry.actionItems.length) {
        parts.push(entry.actionItems.length + ' action item' + (entry.actionItems.length === 1 ? '' : 's'));
    }
    if (entry.stageMoves && entry.stageMoves.length) {
        parts.push(entry.stageMoves.length + ' stage move' + (entry.stageMoves.length === 1 ? '' : 's'));
    }
    if (entry.outcome) parts.push('notes');
    return parts.join(' · ') || 'logged';
}

module.exports = {
    pendingDebriefs,
    recordDebrief,
    summariseDebrief,
    meetingEndMs,
    DEFAULT_LOOKBACK_HOURS,
};
