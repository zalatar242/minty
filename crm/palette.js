/**
 * crm/palette.js — backing search for the Cmd/Ctrl+K command palette.
 *
 * Returns a ranked, typed result list spanning contacts, conversations, goals,
 * companies, and navigation. Designed to be cheap enough to run on every
 * keystroke for realistic dataset sizes (~40k interactions, ~10k contacts) by
 * keeping everything in a couple of linear scans with early-exit limits.
 *
 * Pure functions only. I/O (reading contacts.json, interactions.json) stays in
 * the server module and is passed in via the callers.
 */

'use strict';

const { searchInteractions } = require('./search');

// Static navigation targets. Kept here so the palette stays the single source
// of truth for "what views exist" — the UI just renders whatever comes back.
const NAV_TARGETS = [
    { action: 'today',     label: 'Today',          description: 'Goal-oriented home view',           keywords: ['home', 'goals', 'pulse'] },
    { action: 'contacts',  label: 'People',         description: 'Full contact list',                  keywords: ['contacts', 'directory'] },
    { action: 'ask',       label: 'Ask',            description: 'Natural-language network query',     keywords: ['search', 'query', 'find'] },
    { action: 'network',   label: 'Network',        description: 'Company + relationship graph',       keywords: ['graph', 'map', 'viz'] },
    { action: 'intros',    label: 'Intros',         description: 'Warm-intro path finder',             keywords: ['warm path', 'intro', 'connect'] },
    { action: 'groups',    label: 'Communities',    description: 'WhatsApp groups + LinkedIn groups',  keywords: ['groups', 'chats'] },
    { action: 'sources',   label: 'Sources',        description: 'Manage data connections + imports',  keywords: ['import', 'connect', 'sync'] },
    { action: 'review',    label: 'Review',         description: 'Pending merges + manual matches',    keywords: ['merge', 'dedup'] },
    { action: 'reconnect', label: 'Reconnect',      description: 'Drafts for fading relationships',    keywords: ['warm', 'dormant'] },
    { action: 'digest',    label: 'Weekly digest',  description: 'Auto-synthesized weekly recap',      keywords: ['summary', 'week'] },
];

/**
 * Lightweight scorer for fuzzy matches on short strings.
 *   - exact match (case-insensitive): 100
 *   - startsWith:                      70 + length bonus
 *   - word-start substring:            60
 *   - substring:                       40 + proximity bonus
 *   - no match:                        0
 */
function scoreString(haystack, needle) {
    if (!haystack || !needle) return 0;
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    if (h === n) return 100;
    if (h.startsWith(n)) return 70 + Math.min(20, Math.round((n.length / h.length) * 20));
    const idx = h.indexOf(n);
    if (idx === -1) return 0;
    const isWordStart = idx === 0 || /\W/.test(h.charAt(idx - 1));
    let score = isWordStart ? 60 : 40;
    score += Math.max(0, 20 - idx);
    score += Math.min(15, Math.round((n.length / h.length) * 15));
    return score;
}

/**
 * Build palette results for a query over pre-loaded contacts/interactions/goals.
 *
 * @param {string} query
 * @param {object} ctx   { contacts, interactions, contactMap, contactById, goals, companies }
 * @param {object} [opts] { limit per group }
 */
function paletteSearch(query, ctx, opts = {}) {
    const q = (query || '').trim();
    const maxPerGroup = Math.max(1, Math.min(25, opts.limit || 8));

    if (q.length === 0) {
        // Empty query → show nav + top contacts by warmth (like a "home")
        return {
            query: '',
            results: [
                ...NAV_TARGETS.slice(0, 5).map((n, i) => ({
                    type: 'nav', action: n.action, label: n.label,
                    sublabel: n.description, score: 100 - i,
                })),
                ...topContactsByScore(ctx.contacts || [], 5).map((c, i) => ({
                    type: 'contact',
                    id: c.id,
                    label: c.name || 'Unnamed',
                    sublabel: buildContactSublabel(c),
                    relationshipScore: c.relationshipScore || 0,
                    score: 80 - i,
                    sources: sourceKeys(c),
                })),
            ],
        };
    }

    const results = [];

    // --- 1. Contacts — name / company / email / position
    const contacts = ctx.contacts || [];
    const contactHits = [];
    for (const c of contacts) {
        if (c.isGroup) continue;
        const name = c.name || '';
        const company = (c.sources?.linkedin?.company) || (c.sources?.googleContacts?.org) || '';
        const position = (c.sources?.linkedin?.position) || (c.sources?.googleContacts?.title) || '';
        const emailStr = (c.emails || []).join(' ');
        const best = Math.max(
            scoreString(name, q) * 1.5,
            scoreString(company, q) * 1.0,
            scoreString(position, q) * 0.9,
            scoreString(emailStr, q) * 0.7,
        );
        if (best > 0) contactHits.push({ c, score: best });
    }
    contactHits.sort((a, b) => b.score - a.score);
    for (const { c, score } of contactHits.slice(0, maxPerGroup)) {
        results.push({
            type: 'contact',
            id: c.id,
            label: c.name || 'Unnamed',
            sublabel: buildContactSublabel(c),
            relationshipScore: c.relationshipScore || 0,
            sources: sourceKeys(c),
            score,
        });
    }

    // --- 2. Goals
    for (const g of ctx.goals || []) {
        const s = scoreString(g.text || '', q);
        if (s > 0) {
            results.push({ type: 'goal', id: g.id, label: g.text, score: s });
        }
    }

    // --- 3. Companies
    for (const co of ctx.companies || []) {
        const s = scoreString(co.name || '', q);
        if (s > 0) {
            results.push({
                type: 'company',
                name: co.name,
                count: co.count || (co.contacts ? co.contacts.length : 0),
                label: co.name,
                sublabel: (co.count || 0) + ' people',
                score: s * 0.9,
            });
        }
    }

    // --- 4. Conversations / messages (only if query is long enough to be useful)
    if (q.length >= 3 && ctx.interactions) {
        const searchResult = searchInteractions(ctx.interactions, q, { limit: maxPerGroup });
        for (const hit of searchResult.results) {
            results.push({
                type: 'conversation',
                contactId: hit.contactId,
                contactName: hit.contactName,
                source: hit.source,
                timestamp: hit.timestamp,
                snippet: hit.snippet,
                matches: hit.matches,
                label: hit.contactName || hit.chatName || 'Conversation',
                sublabel: hit.snippet,
                score: 30 + (hit.score || 0) / 2, // conversations rank lower than name hits
            });
        }
    }

    // --- 5. Nav — match label, description, keywords
    for (const nav of NAV_TARGETS) {
        const best = Math.max(
            scoreString(nav.label, q),
            scoreString(nav.description, q) * 0.7,
            ...(nav.keywords || []).map(k => scoreString(k, q)),
        );
        if (best > 0) {
            results.push({
                type: 'nav',
                action: nav.action,
                label: nav.label,
                sublabel: nav.description,
                score: best * 0.8,
            });
        }
    }

    results.sort((a, b) => b.score - a.score);
    return { query: q, results };
}

function topContactsByScore(contacts, n) {
    return contacts
        .filter(c => !c.isGroup && c.name)
        .slice()
        .sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0))
        .slice(0, n);
}

function buildContactSublabel(c) {
    const parts = [];
    const company = c.sources?.linkedin?.company || c.sources?.googleContacts?.org;
    const position = c.sources?.linkedin?.position || c.sources?.googleContacts?.title;
    if (position) parts.push(position);
    if (company) parts.push(company);
    if (parts.length === 0 && (c.emails || []).length > 0) parts.push(c.emails[0]);
    return parts.join(' · ');
}

function sourceKeys(c) {
    return Object.entries(c.sources || {})
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k]) => k);
}

module.exports = {
    paletteSearch,
    scoreString,
    NAV_TARGETS,
};
