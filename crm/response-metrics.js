/**
 * crm/response-metrics.js — per-contact engagement signals.
 *
 * Relationship score is "how accessible is this person?" (recency × frequency ×
 * channels). But that masks a critical question: *do they actually reply to me?*
 * This module computes three independent engagement signals that answer it:
 *
 *   - replyRate              : of my messages to them, what % got a reply within 14 days
 *   - medianReplyLatencyHours: median turnaround of their replies to my messages
 *   - initiationRate         : what share of conversations THEY start (0..1)
 *   - engagementScore        : composite 0..100 — "how engaged are they with me"
 *
 * Designed to run once during merge on the full interaction list. Pure
 * functions — no I/O, no state. Callers supply the interactions array plus a
 * `selfIds` set (the user's own identifiers — 'me', self phone, etc).
 *
 * Messages are paired per (contactId, chatId, source) thread. We walk each
 * thread chronologically and match a user message to the next counter-message
 * from that contact (up to a configurable max-window).
 */

'use strict';

const REPLY_WINDOW_MS      = 14 * 24 * 60 * 60 * 1000; // 14 days
const INITIATION_WINDOW_MS = 24 * 60 * 60 * 1000;      // new "convo" starts after 24h idle

/**
 * Returns true if `from` identifies the user themselves.
 */
function isFromSelf(from, selfIds) {
    if (from === 'me') return true;
    if (!from) return false;
    return selfIds && selfIds.has(String(from));
}

/**
 * Core pair-up: for each thread (contactId + chatId + source), walk in time
 * order and generate { userMsg, contactReply } pairs. Skips messages with no
 * timestamp. `userMsg` without a matching contact reply within REPLY_WINDOW_MS
 * is still emitted (with contactReply=null) so the reply-rate denominator is
 * correct.
 *
 * @param {Array} threadInteractions - interactions in one thread, any order
 * @param {Set}   selfIds
 */
function pairMessages(threadInteractions, selfIds) {
    const sorted = threadInteractions
        .filter(i => i.timestamp)
        .slice()
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const pairs = [];
    for (let i = 0; i < sorted.length; i++) {
        const m = sorted[i];
        if (!isFromSelf(m.from, selfIds)) continue;

        // Search for next contact message within window
        const mT = new Date(m.timestamp).getTime();
        let reply = null;
        for (let j = i + 1; j < sorted.length; j++) {
            const n = sorted[j];
            const nT = new Date(n.timestamp).getTime();
            if (nT - mT > REPLY_WINDOW_MS) break;
            if (!isFromSelf(n.from, selfIds)) { reply = n; break; }
        }
        pairs.push({ userMsg: m, contactReply: reply });
    }
    return pairs;
}

/**
 * Group interactions into thread buckets by (contactId + chatId + source).
 * Falls back to (contactId + source) if chatId missing.
 */
function groupByThread(interactions) {
    const threads = {};
    for (const i of interactions) {
        if (!i._contactId) continue;
        const key = i._contactId + '|' + (i.chatId || '') + '|' + (i.source || '');
        if (!threads[key]) threads[key] = [];
        threads[key].push(i);
    }
    return threads;
}

/**
 * Compute engagement metrics for a single contact from their interaction list.
 * `contactInteractions` is *all* messages between the user and this contact
 * across every thread/source.
 */
function computeContactMetrics(contactInteractions, selfIds) {
    if (!contactInteractions || contactInteractions.length === 0) {
        return defaultMetrics();
    }
    const threads = groupByThread(contactInteractions);

    let totalUserMessages = 0;
    let totalReplies = 0;
    const latenciesMs = [];
    let theyStarted = 0;
    let youStarted = 0;

    for (const threadMsgs of Object.values(threads)) {
        const sorted = threadMsgs
            .filter(i => i.timestamp)
            .slice()
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        if (sorted.length === 0) continue;

        // Identify "conversation starts" — first message of a 24h+ idle window
        let prevTs = null;
        for (const m of sorted) {
            const t = new Date(m.timestamp).getTime();
            const gap = prevTs == null ? Infinity : t - prevTs;
            if (gap > INITIATION_WINDOW_MS) {
                if (isFromSelf(m.from, selfIds)) youStarted++;
                else theyStarted++;
            }
            prevTs = t;
        }

        const pairs = pairMessages(sorted, selfIds);
        for (const p of pairs) {
            totalUserMessages++;
            if (p.contactReply) {
                totalReplies++;
                const dt = new Date(p.contactReply.timestamp) - new Date(p.userMsg.timestamp);
                if (dt > 0) latenciesMs.push(dt);
            }
        }
    }

    const replyRate = totalUserMessages === 0 ? null : totalReplies / totalUserMessages;
    const medianReplyLatencyHours = latenciesMs.length === 0 ? null : median(latenciesMs) / 3600000;
    const totalStarts = theyStarted + youStarted;
    const initiationRate = totalStarts === 0 ? null : theyStarted / totalStarts;

    return {
        messageCount: contactInteractions.length,
        userMessages: totalUserMessages,
        contactReplies: totalReplies,
        replyRate,
        medianReplyLatencyHours,
        initiationRate,
        theyStarted,
        youStarted,
        engagementScore: scoreEngagement({ replyRate, medianReplyLatencyHours, initiationRate }),
    };
}

function defaultMetrics() {
    return {
        messageCount: 0, userMessages: 0, contactReplies: 0,
        replyRate: null, medianReplyLatencyHours: null, initiationRate: null,
        theyStarted: 0, youStarted: 0, engagementScore: 0,
    };
}

function median(arr) {
    if (arr.length === 0) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Blend the three raw metrics into a single 0..100 engagement score:
 *   - replyRate carries 50% (yes/no engagement)
 *   - latency carries 30% (faster = more engaged)
 *   - initiationRate carries 20% (balanced conversations > one-sided)
 */
function scoreEngagement({ replyRate, medianReplyLatencyHours, initiationRate }) {
    let score = 0;
    if (replyRate != null) score += replyRate * 50;
    else score += 15; // unknown data → neutral baseline

    if (medianReplyLatencyHours != null) {
        // < 1h = full 30, 1-6h = 24, 6-24h = 18, 1-3d = 10, > 3d = 3
        let s;
        if (medianReplyLatencyHours < 1)       s = 30;
        else if (medianReplyLatencyHours < 6)  s = 24;
        else if (medianReplyLatencyHours < 24) s = 18;
        else if (medianReplyLatencyHours < 72) s = 10;
        else                                    s = 3;
        score += s;
    } else {
        score += 9;
    }

    if (initiationRate != null) {
        // Ideal is 0.5 (balanced). Penalize one-sided extremes.
        const dist = Math.abs(initiationRate - 0.5);
        score += Math.max(0, 20 - dist * 40);
    } else {
        score += 6;
    }

    return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Compute metrics for every contact in one pass.
 * `interactions` must be pre-decorated with _contactId via the server's
 * buildSearchIndex — otherwise we can't attribute messages to contacts.
 *
 * Returns a map { contactId -> metrics }.
 */
function computeAllMetrics(interactions, selfIds) {
    const byContact = {};
    for (const i of interactions) {
        if (!i._contactId) continue;
        if (!byContact[i._contactId]) byContact[i._contactId] = [];
        byContact[i._contactId].push(i);
    }
    const result = {};
    for (const [cid, list] of Object.entries(byContact)) {
        result[cid] = computeContactMetrics(list, selfIds);
    }
    return result;
}

/**
 * Label helper for the UI. Turns a percent-style rate into a short badge like
 * "92% reply" / "25m avg" / "you chase" / "balanced".
 */
function labelMetrics(m) {
    const out = [];
    if (m.replyRate != null && m.userMessages >= 3) {
        out.push(Math.round(m.replyRate * 100) + '% reply');
    }
    if (m.medianReplyLatencyHours != null) {
        const h = m.medianReplyLatencyHours;
        let label;
        if (h < 1)       label = Math.max(1, Math.round(h * 60)) + 'm avg';
        else if (h < 24) label = Math.round(h) + 'h avg';
        else             label = Math.round(h / 24) + 'd avg';
        out.push(label);
    }
    if (m.initiationRate != null && (m.theyStarted + m.youStarted) >= 3) {
        if (m.initiationRate > 0.7) out.push('they reach out');
        else if (m.initiationRate < 0.3) out.push('you reach out');
        else out.push('balanced');
    }
    return out;
}

module.exports = {
    computeContactMetrics,
    computeAllMetrics,
    pairMessages,
    groupByThread,
    scoreEngagement,
    labelMetrics,
    isFromSelf,
    median,
    REPLY_WINDOW_MS,
    INITIATION_WINDOW_MS,
};
