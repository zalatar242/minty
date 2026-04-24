/**
 * crm/query-reasons.js — per-result evidence + semantic expansion for network
 * query. Turns a ranked candidate list into the "Show thinking" UX — each
 * result carries a list of concrete reasons for why it matched.
 *
 * Pure functions. Caller supplies (parsedQuery, candidates, contactsById,
 * interactionsByContactId, insightsByContactId) and gets back an annotated
 * list with { ...candidate, reasons: [{label, detail, kind}], matchScore }.
 *
 * kind ∈ {
 *   'role'     — matched by role (e.g. founder)
 *   'location' — matched by city/country
 *   'company'  — matched by company name / Apollo headline
 *   'topic'    — matched on conversation topic (via insights.json)
 *   'keyword'  — matched free-text token in Apollo/LinkedIn metadata
 *   'warmth'   — high relationship score
 *   'recent'   — recent interaction
 * }
 */

'use strict';

// ---------------------------------------------------------------------------
// Semantic expansion — a small, curated map of domain terms to related words.
// Chosen to cover the queries a founder / operator / recruiter would ask.
// ---------------------------------------------------------------------------

const TERM_EXPANSIONS = {
    // Infrastructure / engineering
    'notification': ['notification', 'notifications', 'alerts', 'alerting', 'pubsub', 'pager', 'on-call', 'monitoring', 'incident'],
    'alerts':       ['alerts', 'notification', 'pubsub', 'monitoring', 'pagerduty'],
    'realtime':     ['realtime', 'real-time', 'streaming', 'websocket', 'websockets', 'sse', 'event-driven'],
    'payments':     ['payments', 'checkout', 'billing', 'subscription', 'stripe', 'adyen', 'braintree'],
    'fintech':      ['fintech', 'banking', 'neo bank', 'digital bank', 'monzo', 'revolut', 'n26', 'starling', 'treasury'],
    'ai':           ['ai', 'machine learning', 'ml', 'llm', 'gpt', 'transformer', 'foundation model', 'deep learning'],
    'ml':           ['ml', 'machine learning', 'ai', 'llm', 'deep learning', 'training', 'inference'],
    'llm':          ['llm', 'large language model', 'foundation model', 'gpt', 'claude', 'transformer'],
    'data':         ['data', 'analytics', 'warehouse', 'etl', 'elt', 'snowflake', 'databricks'],
    'devtools':     ['devtools', 'developer tools', 'dx', 'ide', 'build', 'ci', 'cd', 'deploy'],
    'infra':        ['infra', 'infrastructure', 'platform', 'devops', 'sre', 'reliability'],
    'security':     ['security', 'cyber', 'infosec', 'appsec', 'zero trust', 'vuln', 'pentest'],
    'design':       ['design', 'designer', 'ux', 'ui', 'product design', 'brand', 'figma'],
    'growth':       ['growth', 'marketing', 'acquisition', 'funnel', 'activation', 'seo', 'paid'],
    'sales':        ['sales', 'revenue', 'bd', 'business development', 'account', 'enterprise', 'gtm'],
    'hr':           ['hr', 'people', 'talent', 'recruiting', 'hiring', 'l&d', 'talent ops'],
    'legal':        ['legal', 'counsel', 'compliance', 'lawyer', 'attorney', 'privacy'],
    'mobile':       ['mobile', 'ios', 'android', 'react native', 'flutter', 'swift', 'kotlin'],
    'web3':         ['web3', 'crypto', 'blockchain', 'defi', 'nft', 'dao'],
    'climate':      ['climate', 'sustainability', 'carbon', 'net zero', 'clean tech', 'energy'],
    // Stage / corporate structure
    'seed':         ['seed', 'pre-seed', 'angel', 'first check', 'idea stage'],
    'series a':     ['series a', 'round a', 'post-seed'],
    'series b':     ['series b', 'round b', 'growth stage'],
    'ipo':          ['ipo', 'public', 'listed', 'nasdaq', 'nyse'],
    // Goal intents
    'raise':        ['raise', 'fundraise', 'round', 'capital', 'investment'],
    'hire':         ['hire', 'recruit', 'talent', 'onboard'],
    'intro':        ['intro', 'introduction', 'warm intro', 'connect'],
    // Well-known companies → aliases so "big tech" queries work
    'big tech':     ['google', 'meta', 'facebook', 'apple', 'amazon', 'microsoft', 'netflix'],
    'faang':        ['meta', 'facebook', 'apple', 'amazon', 'netflix', 'google', 'alphabet'],
};

// Words that are too common to index as free-text matches.
const STOP = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'are', 'you',
    'who', 'what', 'how', 'can', 'someone', 'anybody', 'anyone', 'people',
    'my', 'me', 'your', 'our',
]);

// ---------------------------------------------------------------------------
// Query → expanded term set
// ---------------------------------------------------------------------------

function expandTerm(term) {
    const lower = term.toLowerCase();
    return TERM_EXPANSIONS[lower] ? TERM_EXPANSIONS[lower].slice() : [lower];
}

/**
 * Split the raw query into candidate free-text terms, drop stop-words and
 * terms already captured by structured fields (roles, locations).
 */
function extractFreeTerms(raw, parsed) {
    const usedFragments = new Set([
        ...(parsed.roles || []),
        ...(parsed.locations || []),
    ]);
    const lower = String(raw || '').toLowerCase();

    // Multi-word bigrams first (so "notification systems" is one term)
    const tokens = lower
        .split(/[^a-z0-9]+/)
        .filter(t => t && t.length > 2 && !STOP.has(t) && !usedFragments.has(t));
    const bigrams = [];
    for (let i = 0; i < tokens.length - 1; i++) {
        bigrams.push(tokens[i] + ' ' + tokens[i + 1]);
    }

    const result = [];
    for (const bg of bigrams) {
        if (TERM_EXPANSIONS[bg]) result.push(bg);
    }
    for (const tok of tokens) {
        if (!result.some(r => r.includes(tok))) result.push(tok);
    }
    return result;
}

function expandQuery(parsed) {
    const freeTerms = extractFreeTerms(parsed.raw || '', parsed);
    const expanded = [];
    const seen = new Set();
    for (const t of freeTerms) {
        for (const e of expandTerm(t)) {
            if (!seen.has(e)) { seen.add(e); expanded.push(e); }
        }
    }
    return { freeTerms, expandedTerms: expanded };
}

// ---------------------------------------------------------------------------
// Per-candidate evidence
// ---------------------------------------------------------------------------

function buildReasons(candidate, parsed, ctx = {}) {
    const reasons = [];
    const contact = (ctx.contactsById && ctx.contactsById[candidate.id]) || null;
    const insight = (ctx.insightsByContactId && ctx.insightsByContactId[candidate.id]) || null;
    const lowerQuery = String(parsed.raw || '').toLowerCase();

    // Role reasons
    if (parsed.roles && parsed.roles.length) {
        const matched = parsed.roles.filter(r => (candidate.roles || []).includes(r));
        for (const r of matched) {
            reasons.push({
                kind: 'role',
                label: titleCase(r),
                detail: candidate.title ? candidate.title : (candidate.company ? 'at ' + candidate.company : null),
            });
        }
    }

    // Location reasons
    if (parsed.locations && parsed.locations.length) {
        for (const l of parsed.locations) {
            if (candidate.city === l) {
                reasons.push({ kind: 'location', label: titleCase(l), detail: 'Confirmed location' });
            }
        }
    }

    // Company / free-term matches against LinkedIn / Apollo headline / email domain
    const { expandedTerms } = expandQuery(parsed);
    const contactText = collectContactText(contact || candidate);
    for (const term of expandedTerms) {
        if (term.length < 3) continue;
        if (contactText.includes(term)) {
            reasons.push({
                kind: 'keyword',
                label: term,
                detail: explainKeywordMatch(contact || candidate, term),
            });
            if (reasons.filter(r => r.kind === 'keyword').length >= 3) break;
        }
    }

    // Topic match — interaction insights
    if (insight && Array.isArray(insight.topics)) {
        for (const t of insight.topics) {
            if (!t) continue;
            const tl = t.toLowerCase();
            if (expandedTerms.some(et => tl.includes(et) || et.includes(tl))) {
                reasons.push({ kind: 'topic', label: 'Recent conversation', detail: t });
                break;
            }
            // Or direct match against raw query terms
            if (lowerQuery.includes(tl) || tl.includes(lowerQuery)) {
                reasons.push({ kind: 'topic', label: 'Recent conversation', detail: t });
                break;
            }
        }
    }

    // Warmth signal — only when the query implies access (intro, ask, meet)
    const wantsWarm = ['meet', 'intro'].includes(parsed.intent) || /warm|intro|trust/.test(lowerQuery);
    if (wantsWarm && candidate.relationshipScore >= 50) {
        reasons.push({
            kind: 'warmth',
            label: 'Warm',
            detail: 'Relationship score ' + candidate.relationshipScore,
        });
    }

    // Recent contact
    if (candidate.daysSinceContact != null && candidate.daysSinceContact <= 14) {
        reasons.push({
            kind: 'recent',
            label: 'Recent',
            detail: candidate.daysSinceContact === 0 ? 'Today' :
                    candidate.daysSinceContact === 1 ? 'Yesterday' :
                    candidate.daysSinceContact + ' days ago',
        });
    }

    return reasons;
}

function explainKeywordMatch(c, term) {
    if (!c) return null;
    const t = term.toLowerCase();
    const checks = [
        { val: c.company, label: 'Company' },
        { val: c.title || c.position, label: 'Title' },
        { val: c.sources?.linkedin?.company, label: 'LinkedIn company' },
        { val: c.sources?.linkedin?.position, label: 'LinkedIn title' },
        { val: c.apollo?.headline, label: 'Headline' },
        { val: c.apollo?.industry, label: 'Industry' },
    ];
    for (const { val, label } of checks) {
        if (!val) continue;
        if (String(val).toLowerCase().includes(t)) return label + ': ' + val;
    }
    return null;
}

function collectContactText(c) {
    if (!c) return '';
    return [
        c.name, c.company, c.title, c.position,
        c.sources?.linkedin?.company, c.sources?.linkedin?.position,
        c.sources?.googleContacts?.org, c.sources?.googleContacts?.title,
        c.apollo?.headline, c.apollo?.industry, c.apollo?.location,
    ].filter(Boolean).join(' ').toLowerCase();
}

function titleCase(s) {
    return String(s || '').split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ---------------------------------------------------------------------------
// Top-level enhancer
// ---------------------------------------------------------------------------

/**
 * Annotate a list of candidate results with reasons + a match score.
 * Returns a new array; does not mutate inputs.
 *
 * The match score blends:
 *   - structured match weight (role + location → strong signal)
 *   - keyword match count (weaker)
 *   - conversation topic match (medium)
 *   - warmth / recency bonuses (tiny — only used as tie-breakers)
 */
function annotateResults(parsed, candidates, ctx = {}) {
    return candidates.map(c => {
        const reasons = buildReasons(c, parsed, ctx);
        const kindWeights = { role: 40, location: 25, company: 20, topic: 20, keyword: 10, warmth: 6, recent: 4 };
        let matchScore = 0;
        for (const r of reasons) matchScore += kindWeights[r.kind] || 1;
        return { ...c, reasons, matchScore };
    });
}

module.exports = {
    expandTerm,
    expandQuery,
    extractFreeTerms,
    buildReasons,
    annotateResults,
    collectContactText,
    TERM_EXPANSIONS,
};
