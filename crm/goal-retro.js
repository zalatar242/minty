/**
 * crm/goal-retro.js — generate a post-mortem / status retro for a goal.
 *
 * Any time, click "Retro" on a goal and Minty synthesises:
 *   - overall funnel status (how many contacts per stage)
 *   - who's moving vs who's stuck
 *   - engagement metrics by assigned contact (reply rate, latency)
 *   - timing: average time in each stage, longest gap
 *   - paths that worked / open loops
 *
 * Pure functions; the caller supplies the goal, full contact list, their
 * interactions, and (optionally) cached engagement metrics.
 */

'use strict';

const { computeContactMetrics } = require('./response-metrics');

const DEFAULT_STAGES = ['To reach out', 'Contacted', 'Meeting', 'Intro made', 'Closed'];

/**
 * Build a retro object for a goal.
 *
 * @param {object} goal                     — goal with { text, stages[], assignments }
 * @param {Array<object>} contacts          — every contact (for lookup)
 * @param {object} interactionsByContactId  — { contactId -> [interaction] }
 * @param {Set} selfIds                     — user's own identifiers for metrics
 * @param {Date|number} [now]
 */
function buildGoalRetro(goal, contacts, interactionsByContactId, selfIds = new Set(['me']), now = Date.now()) {
    if (!goal) return null;
    const stages = Array.isArray(goal.stages) && goal.stages.length ? goal.stages : DEFAULT_STAGES;
    const assignments = goal.assignments || {};
    const byId = new Map((contacts || []).map(c => [c.id, c]));

    const funnel = stages.map(s => ({ stage: s, count: 0, contacts: [] }));
    const stuck = [];      // assigned > 14d ago, still in same stage
    const moving = [];     // moved to a later stage in last 14d
    const ghosted = [];    // user initiated, no reply in 14d
    const replied = [];    // contact responded within 72h
    const activeContacts = [];

    const STUCK_DAYS = 14;
    const nowMs = typeof now === 'number' ? now : new Date(now).getTime();

    // Per-contact engagement
    const engagementByContactId = {};
    for (const [cid] of Object.entries(assignments)) {
        const list = interactionsByContactId[cid] || [];
        engagementByContactId[cid] = computeContactMetrics(list, selfIds);
    }

    // Classify
    for (const [cid, ass] of Object.entries(assignments)) {
        const c = byId.get(cid);
        if (!c) continue;
        const stageLabel = (ass && ass.stage) || (typeof ass === 'string' ? ass : null);
        if (!stageLabel) continue;
        const stageIdx = stages.findIndex(s => s.toLowerCase() === stageLabel.toLowerCase());
        if (stageIdx < 0) continue;

        const m = engagementByContactId[cid] || {};
        const updatedAt = ass && ass.updatedAt ? new Date(ass.updatedAt).getTime() : null;
        const ageDays = updatedAt ? Math.floor((nowMs - updatedAt) / 86400000) : null;

        const entry = {
            id: cid,
            name: c.name || null,
            company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
            position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
            relationshipScore: c.relationshipScore || 0,
            daysSinceContact: c.daysSinceContact ?? null,
            stage: stageLabel,
            stageIdx,
            ageDays,
            replyRate: m.replyRate,
            medianReplyLatencyHours: m.medianReplyLatencyHours,
            engagementScore: m.engagementScore,
        };
        funnel[stageIdx].contacts.push(entry);
        funnel[stageIdx].count++;
        activeContacts.push(entry);

        if (ageDays != null && ageDays > STUCK_DAYS) {
            stuck.push(entry);
        }
        if (ageDays != null && ageDays <= STUCK_DAYS) {
            moving.push(entry);
        }
        // Reply/ghost classification requires some signal
        if (m.userMessages >= 1) {
            if (m.replyRate === 0 && c.daysSinceContact != null && c.daysSinceContact >= 14) {
                ghosted.push(entry);
            } else if (m.replyRate != null && m.replyRate >= 0.5 && m.medianReplyLatencyHours != null && m.medianReplyLatencyHours <= 72) {
                replied.push(entry);
            }
        }
    }

    // Aggregate stats
    const aggregate = {
        totalAssigned:   activeContacts.length,
        responded:       replied.length,
        ghosted:         ghosted.length,
        stuck:           stuck.length,
        moving:          moving.length,
        progressed:      countProgressed(stages, activeContacts),
        avgEngagement:   avg(activeContacts.map(c => c.engagementScore || 0)),
        avgReplyRateKnown: avg(activeContacts
            .map(c => c.replyRate)
            .filter(r => typeof r === 'number')),
    };

    const narrative = narrate(goal, aggregate, stages, funnel);

    return {
        goalId: goal.id,
        goalText: goal.text,
        stages,
        funnel,
        stuck,
        moving,
        ghosted,
        replied,
        aggregate,
        narrative,
        generatedAt: new Date(nowMs).toISOString(),
    };
}

/** % of assigned contacts who have moved past the first stage */
function countProgressed(stages, contacts) {
    if (contacts.length === 0) return 0;
    const past = contacts.filter(c => c.stageIdx > 0).length;
    return Math.round((past / contacts.length) * 100);
}

function avg(arr) {
    if (!arr || arr.length === 0) return 0;
    return Math.round((arr.reduce((s, v) => s + (v || 0), 0) / arr.length) * 10) / 10;
}

/**
 * Produce a human-readable narrative paragraph describing goal state.
 * Deliberately short — 3 sentences max.
 */
function narrate(goal, agg, stages, funnel) {
    const parts = [];

    if (agg.totalAssigned === 0) {
        return 'No one is in this goal’s pipeline yet. Start by assigning warm contacts — the Ask view suggests people relevant to "' +
               (goal.text || 'this goal') + '".';
    }

    parts.push(
        `${agg.totalAssigned} contact${agg.totalAssigned === 1 ? '' : 's'} in pipeline, ${agg.progressed}% past the first stage.`
    );

    // Where are people
    const busiest = funnel.map((s, i) => ({ ...s, i })).sort((a, b) => b.count - a.count)[0];
    if (busiest && busiest.count > 0) {
        parts.push('Most people are at "' + busiest.stage + '" (' + busiest.count + ').');
    }

    // Momentum / stuck callout
    if (agg.stuck > 0 && agg.moving === 0) {
        parts.push(
            'No movement in 14 days — ' + agg.stuck + ' contact' + (agg.stuck === 1 ? '' : 's') +
            ' could use a nudge.'
        );
    } else if (agg.ghosted > 0) {
        parts.push(
            agg.ghosted + ' ghosted you (no reply to your last message). Consider dropping them or trying a different channel.'
        );
    } else if (agg.replied >= Math.max(1, Math.floor(agg.totalAssigned / 3))) {
        parts.push('Strong response rate — ' + agg.replied + ' replied promptly. Keep the momentum.');
    }

    return parts.join(' ');
}

module.exports = {
    buildGoalRetro,
    narrate,
    DEFAULT_STAGES,
};
