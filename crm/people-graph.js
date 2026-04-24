/**
 * crm/people-graph.js — pure functions for the WhatsApp-derived people graph.
 *
 * Depends on three inputs, all loaded by callers (no I/O here):
 *   - contacts:    unified contact list from data/unified/contacts.json
 *   - memberships: data/unified/group-memberships.json
 *                  (chatId -> { name, size, members: [contactId, ...], ... })
 *
 * Semantic assumption: Minty is single-user. Every group in memberships is a
 * group the user (viewer) is in. Therefore "shared with you" for any target
 * contact X equals X.groupMemberships directly — no intersection required.
 */

'use strict';

// ---------------------------------------------------------------------------
// Edge weighting
// ---------------------------------------------------------------------------

/**
 * Weight for a single shared-group edge.
 * Small groups = stronger tie. 2-person "SF Pierogi" ≫ 400-person "Gen Z VC".
 * Formula: 1 / log2(2 + size). Bounded in (0, 1].
 *
 * @param {number} size - Group membership count.
 * @returns {number}
 */
function groupEdgeWeight(size) {
    const n = Math.max(0, Number(size) || 0);
    return 1 / Math.log2(2 + n);
}

// ---------------------------------------------------------------------------
// Shared groups (for contact-detail "you're both in…" section)
// ---------------------------------------------------------------------------

/**
 * Return the groups shared with the target contact, enriched with size +
 * category metadata. Sorted smallest-first (highest signal first).
 *
 * @param {object} contact      - Unified contact object with groupMemberships[].
 * @param {object} memberships  - data/unified/group-memberships.json.
 * @returns {Array<{chatId, name, size, isAdmin, isSuperAdmin, createdAt, owner}>}
 */
function getSharedGroups(contact, memberships) {
    if (!contact || !Array.isArray(contact.groupMemberships)) return [];
    const out = [];
    for (const m of contact.groupMemberships) {
        const g = memberships[m.chatId];
        if (!g) continue;
        out.push({
            chatId: m.chatId,
            name: g.name || m.chatName || m.chatId,
            size: g.size || (g.members && g.members.length) || 0,
            isAdmin: !!m.isAdmin,
            isSuperAdmin: !!m.isSuperAdmin,
            createdAt: g.createdAt || null,
            owner: g.owner || null,
        });
    }
    return out.sort((a, b) => {
        // smaller groups first (tighter tie); ties broken by name
        const d = (a.size || 0) - (b.size || 0);
        return d !== 0 ? d : a.name.localeCompare(b.name);
    });
}

// ---------------------------------------------------------------------------
// Reverse-intro path finder (A8)
// ---------------------------------------------------------------------------

/**
 * Find the warmest people who could intro you to a target contact, using
 * shared-group co-membership as the edge signal.
 *
 * For target T:
 *   1. Enumerate groups G that T is in (all are groups you're in too).
 *   2. For each G, every other member Y is a candidate intro.
 *   3. Score Y by sum over shared groups G of (edgeWeight(|G|))
 *      scaled by Y.relationshipScore (strong tie → warmer intro).
 *   4. Skip Y if the only shared group with T is too large (noise floor).
 *
 * @param {string} targetId                  - Unified contact ID of the target.
 * @param {Array<object>} contacts           - Unified contacts.
 * @param {object} memberships               - group-memberships.json.
 * @param {object} [opts]
 * @param {number} [opts.maxPaths=5]         - Top-N candidates to return.
 * @param {number} [opts.maxGroupSize=200]   - Groups bigger than this are ignored for edges.
 * @param {Array<string>} [opts.excludeIds]  - Contact IDs to skip as intermediaries
 *                                             (typically the viewer themselves).
 * @returns {Array<{
 *     intermediaryId, intermediaryName, intermediaryScore,
 *     sharedGroupsWithTarget: Array<{chatId, name, size}>,
 *     pathScore
 * }>}
 */
function findIntroPaths(targetId, contacts, memberships, opts = {}) {
    const maxPaths = opts.maxPaths ?? 5;
    const maxGroupSize = opts.maxGroupSize ?? 200;
    const excludeIds = new Set(Array.isArray(opts.excludeIds) ? opts.excludeIds : []);
    excludeIds.add(targetId);
    if (!targetId || !Array.isArray(contacts)) return [];

    const contactById = new Map();
    for (const c of contacts) contactById.set(c.id, c);
    const target = contactById.get(targetId);
    if (!target || !Array.isArray(target.groupMemberships)) return [];

    // Groups the target is in, filtered by size.
    const targetGroups = [];
    for (const m of target.groupMemberships) {
        const g = memberships[m.chatId];
        if (!g) continue;
        const size = g.size || (g.members && g.members.length) || 0;
        if (size <= 0 || size > maxGroupSize) continue;
        targetGroups.push({ chatId: m.chatId, name: g.name || m.chatName, size, members: g.members || [] });
    }
    if (targetGroups.length === 0) return [];

    // Accumulate candidates: intermediaryId -> { sharedGroupScore, sharedGroups[] }
    const candidates = new Map();
    for (const g of targetGroups) {
        const w = groupEdgeWeight(g.size);
        for (const memberId of g.members) {
            if (excludeIds.has(memberId)) continue;
            let entry = candidates.get(memberId);
            if (!entry) {
                entry = { sharedGroupScore: 0, sharedGroups: [] };
                candidates.set(memberId, entry);
            }
            entry.sharedGroupScore += w;
            entry.sharedGroups.push({ chatId: g.chatId, name: g.name, size: g.size });
        }
    }

    // Materialize + rank by (relationshipScore + 1) * sharedGroupScore.
    // +1 so silent-lurker intermediaries (score 0) still rank above nothing.
    const ranked = [];
    for (const [id, entry] of candidates.entries()) {
        const c = contactById.get(id);
        if (!c || !c.name) continue; // skip unnamed anonymous contacts as intro candidates
        if (c.isGroup) continue;
        const rel = Number(c.relationshipScore) || 0;
        const pathScore = (rel + 1) * entry.sharedGroupScore;
        ranked.push({
            intermediaryId: id,
            intermediaryName: c.name,
            intermediaryScore: rel,
            intermediaryTitle: c.apollo?.headline ||
                c.sources?.linkedin?.position ||
                c.sources?.googleContacts?.title || null,
            intermediaryCompany: c.sources?.linkedin?.company ||
                c.sources?.googleContacts?.org || null,
            sharedGroupsWithTarget: entry.sharedGroups.sort((a, b) => a.size - b.size).slice(0, 3),
            pathScore: Math.round(pathScore * 1000) / 1000,
        });
    }

    ranked.sort((a, b) => b.pathScore - a.pathScore);
    return ranked.slice(0, maxPaths);
}

// ---------------------------------------------------------------------------
// Group-path signal for network-query ranking boost
// ---------------------------------------------------------------------------

/**
 * Build a map contactId -> groupSignalScore suitable for additive boost in
 * network-query.filterIndex. Higher = more tied into the user's WhatsApp
 * social graph (many small groups > one mega group).
 *
 * Useful for biasing Ask-tab ranking toward contacts the user has more
 * meaningful WhatsApp proximity with, even when LinkedIn/email data is thin.
 *
 * @param {Array<object>} contacts
 * @param {object} memberships
 * @returns {Object<string, number>}  contactId -> score (approx 0..N)
 */
function computeGroupSignalScores(contacts, memberships) {
    const out = {};
    for (const c of contacts) {
        if (!Array.isArray(c.groupMemberships) || c.groupMemberships.length === 0) continue;
        let score = 0;
        for (const m of c.groupMemberships) {
            const g = memberships[m.chatId];
            if (!g) continue;
            const size = g.size || (g.members && g.members.length) || 0;
            if (size <= 0) continue;
            score += groupEdgeWeight(size);
        }
        out[c.id] = Math.round(score * 100) / 100;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Top intro candidates across the network (for digest.js)
// ---------------------------------------------------------------------------

/**
 * For each "top reconnect" target, compute the single warmest intermediary.
 * Surfaces on the weekly digest as "Priya's gasp moment" — the warm-path
 * intro that you didn't know you had.
 *
 * @param {Array<{id, name}>} targets       - Shortlist (e.g. top 8 reconnects).
 * @param {Array<object>} contacts
 * @param {object} memberships
 * @param {object} [opts]
 * @returns {Array<{target, intermediary, sharedGroup}>}
 */
function buildWarmIntroBriefs(targets, contacts, memberships, opts = {}) {
    const briefs = [];
    const baseOpts = { ...opts, maxPaths: 1 };
    for (const t of targets) {
        const paths = findIntroPaths(t.id, contacts, memberships, baseOpts);
        if (!paths.length) continue;
        const top = paths[0];
        briefs.push({
            target: { id: t.id, name: t.name },
            intermediary: {
                id: top.intermediaryId,
                name: top.intermediaryName,
                score: top.intermediaryScore,
                title: top.intermediaryTitle,
                company: top.intermediaryCompany,
            },
            sharedGroup: top.sharedGroupsWithTarget[0] || null,
            pathScore: top.pathScore,
        });
    }
    return briefs.sort((a, b) => b.pathScore - a.pathScore);
}

// ---------------------------------------------------------------------------

module.exports = {
    groupEdgeWeight,
    getSharedGroups,
    findIntroPaths,
    computeGroupSignalScores,
    buildWarmIntroBriefs,
};
