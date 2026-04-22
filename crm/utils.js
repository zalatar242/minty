/**
 * Pure utility functions extracted from merge.js for testability.
 * All functions here are side-effect free — no file I/O, no state.
 */

const { createContact } = require('./schema');

// ---------------------------------------------------------------------------
// Phone normalization
// ---------------------------------------------------------------------------

function normalizePhone(phone) {
    if (!phone) return null;
    let p = phone.replace(/[^0-9+]/g, '');
    // Convert international dialing prefix (011...) to + format
    if (p.startsWith('011') && p.length > 11) p = '+' + p.slice(3);
    return p;
}

// Canonical key for the phone index: digits only, no + or formatting.
// Ensures +16308911555 and 16308911555 hit the same bucket.
function phoneKey(phone) {
    if (!phone) return null;
    const d = phone.replace(/[^0-9]/g, '');
    return d.length >= 7 ? d : null;
}

// ---------------------------------------------------------------------------
// Email / name normalization
// ---------------------------------------------------------------------------

function normalizeEmail(email) {
    if (!email) return null;
    return email.toLowerCase().trim();
}

// Normalize a name to "firstname lastname" (first two words, lowercased).
// Used for fuzzy cross-source name matching.
function normalizeName(name) {
    if (!name) return null;
    const words = name.toLowerCase().trim().split(/\s+/);
    return words.slice(0, 2).join(' ');
}

// ---------------------------------------------------------------------------
// Relationship scoring — pure functions, each testable in isolation
// ---------------------------------------------------------------------------

/**
 * Recency score (0–100) based on days since last contact.
 * Contributes 50% to the final relationship score.
 */
function recencyScore(daysSince) {
    if (daysSince === null || daysSince === undefined) return 0;
    if (daysSince < 7)   return 100;
    if (daysSince < 30)  return 80;
    if (daysSince < 90)  return 60;
    if (daysSince < 180) return 30;
    if (daysSince < 365) return 10;
    return 0;
}

/**
 * Frequency score (0–100) log-normalized against the p90 interaction count.
 * Contributes 30% to the final relationship score.
 */
function frequencyScore(count, p90) {
    if (!count || count === 0) return 0;
    const ref = p90 || 1;
    return Math.min(100, Math.round((Math.log1p(count) / Math.log1p(ref)) * 100));
}

/**
 * Channel score (0–100): 20 points per unique source, capped at 5 channels.
 * Contributes 20% to the final relationship score.
 */
function channelScore(channels) {
    return Math.min(100, (channels || []).length * 20);
}

/**
 * Final relationship score (0–100) from the three sub-scores.
 * Weights: recency 50%, frequency 30%, channel 20%.
 */
function relationshipScore(recency, frequency, channel) {
    return Math.round(recency * 0.5 + frequency * 0.3 + channel * 0.2);
}

// ---------------------------------------------------------------------------
// ContactIndex — in-memory contact deduplication store
// ---------------------------------------------------------------------------

class ContactIndex {
    constructor() {
        this.contacts = [];
        this.byId    = {};   // id -> contact
        this.byPhone = {};   // digits-only phone key -> contact
        this.byEmail = {};   // normalizedEmail -> contact
        this.byName  = {};   // lowerName -> contact
        this._nextId = 1;
        this._phoneCollisions = 0;
    }

    _newId() { return `c_${String(this._nextId++).padStart(4, '0')}`; }

    find(phones, emails, name) {
        for (const p of phones) {
            const k = phoneKey(normalizePhone(p));
            if (k && this.byPhone[k]) return this.byPhone[k];
        }
        for (const e of emails) {
            const n = normalizeEmail(e);
            if (n && this.byEmail[n]) return this.byEmail[n];
        }
        if (name) {
            const key = name.toLowerCase().trim();
            if (key.length > 2 && this.byName[key]) return this.byName[key];
        }
        return null;
    }

    add(contact) {
        this.contacts.push(contact);
        this.byId[contact.id] = contact;
        for (const p of contact.phones) {
            const k = phoneKey(normalizePhone(p));
            if (k) this.byPhone[k] = contact;
        }
        for (const e of contact.emails) {
            const n = normalizeEmail(e);
            if (n) this.byEmail[n] = contact;
        }
        if (contact.name) {
            const key = contact.name.toLowerCase().trim();
            if (key.length > 2) this.byName[key] = contact;
        }
        return contact;
    }

    _mergeInto(winner, other) {
        for (const [src, val] of Object.entries(other.sources)) {
            if (val !== null && winner.sources[src] === null) winner.sources[src] = val;
        }
        for (const p of other.phones) {
            const k = phoneKey(normalizePhone(p));
            if (k && !winner.phones.some(wp => phoneKey(normalizePhone(wp)) === k)) {
                winner.phones.push(p);
            }
            if (k) this.byPhone[k] = winner;
        }
        for (const e of other.emails) {
            const n = normalizeEmail(e);
            if (n && !winner.emails.includes(n)) {
                winner.emails.push(n);
                this.byEmail[n] = winner;
            }
        }
        if (!winner.name && other.name) {
            winner.name = other.name;
            const key = other.name.toLowerCase().trim();
            if (key.length > 2) this.byName[key] = winner;
        }
        this.contacts = this.contacts.filter(c => c.id !== other.id);
        delete this.byId[other.id];
        for (const [k, c] of Object.entries(this.byPhone)) {
            if (c === other) this.byPhone[k] = winner;
        }
        this._phoneCollisions++;
    }

    upsert(phones, emails, name, stableId = null) {
        let c = this.find(phones, emails, name);
        if (!c) {
            c = createContact(stableId || this._newId());
            this.add(c);
        }
        for (const p of phones) {
            const n = normalizePhone(p);
            const k = phoneKey(n);
            if (!n || !k) continue;
            const incumbent = this.byPhone[k];
            if (incumbent && incumbent !== c) {
                this._mergeInto(c, incumbent);
            }
            if (!c.phones.some(cp => phoneKey(normalizePhone(cp)) === k)) {
                c.phones.push(n);
            }
            this.byPhone[k] = c;
        }
        for (const e of emails) {
            const n = normalizeEmail(e);
            if (n && !c.emails.includes(n)) {
                c.emails.push(n);
                this.byEmail[n] = c;
            }
        }
        if (!c.name && name) {
            c.name = name;
            const key = name.toLowerCase().trim();
            if (key.length > 2) this.byName[key] = c;
        }
        return c;
    }
}

// ---------------------------------------------------------------------------
// Sync status utilities
// ---------------------------------------------------------------------------

const STALE_LIVE_MS   = 24 * 60 * 60 * 1000; // 24 hours for live sources (WhatsApp, Email)
const STALE_FILE_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days for file-based sources

/**
 * Formats an ISO timestamp as a human-readable age string.
 * @param {string|null} isoStr
 * @param {number} [now=Date.now()]
 * @returns {string} e.g. "just now", "3 min ago", "2 hr ago", "4 days ago", "never"
 */
function formatSyncAge(isoStr, now = Date.now()) {
    if (!isoStr) return 'never';
    const ms = now - new Date(isoStr).getTime();
    if (ms < 0) return 'just now';
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.floor(ms / 3600000);
    if (hrs < 24) return hrs + ' hr ago';
    const days = Math.floor(ms / 86400000);
    if (days === 1) return '1 day ago';
    if (days < 30) return days + ' days ago';
    const months = Math.floor(days / 30);
    return months + (months === 1 ? ' month ago' : ' months ago');
}

/**
 * Returns the display state of a sync source based on its state object.
 * @param {Object|null} sourceState - { status, lastSyncAt }
 * @param {string} [sourceType] - 'live' | 'file' (affects stale threshold)
 * @param {number} [now=Date.now()]
 * @returns {'active'|'ok'|'stale'|'error'|'idle'}
 */
function getSyncDotState(sourceState, sourceType = 'live', now = Date.now()) {
    if (!sourceState) return 'idle';
    const { status, lastSyncAt } = sourceState;
    if (status === 'error') return 'error';
    if (status === 'syncing' || status === 'active') return 'active';
    if (status === 'stale') return 'stale';
    if (!lastSyncAt) return 'idle';
    const ms = now - new Date(lastSyncAt).getTime();
    const threshold = sourceType === 'file' ? STALE_FILE_MS : STALE_LIVE_MS;
    if (ms > threshold) return 'stale';
    return 'ok';
}

/**
 * Computes the overall sync health across all sync states.
 * @param {Object} syncState - keys: whatsapp, email, googleContacts, linkedin, telegram, sms
 * @returns {{ state: 'ok'|'stale'|'error'|'idle', message: string }}
 */
function getOverallSyncHealth(syncState) {
    const LABELS = {
        whatsapp: 'WhatsApp', email: 'Email', googleContacts: 'Google Contacts',
        linkedin: 'LinkedIn', telegram: 'Telegram', sms: 'SMS',
    };
    const FILE_SOURCES = new Set(['linkedin', 'telegram', 'sms']);

    if (!syncState || Object.keys(syncState).filter(k => LABELS[k]).length === 0) {
        return { state: 'idle', message: 'No sources connected' };
    }

    for (const [key, s] of Object.entries(syncState)) {
        if (!LABELS[key]) continue;
        if (s.status === 'error') {
            return { state: 'error', message: `${LABELS[key]} sync error — check Sources` };
        }
    }

    for (const [key, s] of Object.entries(syncState)) {
        if (!LABELS[key]) continue;
        const type = FILE_SOURCES.has(key) ? 'file' : 'live';
        if (getSyncDotState(s, type) === 'stale') {
            return { state: 'stale', message: `${LABELS[key]} is outdated — refresh?` };
        }
    }

    return { state: 'ok', message: 'All sources current' };
}

// ---------------------------------------------------------------------------
// Health ring helpers (browser-mirrored pure functions)
// ---------------------------------------------------------------------------

/**
 * Returns the health tier name for a relationship score.
 * Used to select CSS variable names (--health-<tier>).
 */
function healthRingColor(score) {
    if (score >= 70) return 'strong';
    if (score >= 40) return 'good';
    if (score >= 20) return 'warm';
    if (score >  0)  return 'fading';
    return 'none';
}

/**
 * Returns the SVG stroke-dashoffset for a health ring arc.
 * Ring uses r=21 circle; circumference ≈ 131.95.
 * offset=0  → full circle (100%)
 * offset=C  → empty ring (0%)
 */
function healthRingOffset(score) {
    const R = 21;
    const C = 2 * Math.PI * R;
    const pct = Math.max(0, Math.min(100, score || 0));
    return parseFloat((C * (1 - pct / 100)).toFixed(1));
}

// ---------------------------------------------------------------------------
// Goal-oriented contact scoring
// ---------------------------------------------------------------------------

// Role category keyword maps — mirrors index.js role extraction
const GOAL_ROLE_SIGNALS = {
    investor:   ['investor', 'vc', 'venture', 'angel', 'fund', 'capital', 'partner', 'gp', 'lp', 'portfolio'],
    founder:    ['founder', 'co-founder', 'cofounder', 'ceo', 'startup', 'entrepreneur'],
    engineer:   ['engineer', 'developer', 'cto', 'software', 'tech lead', 'backend', 'frontend'],
    operator:   ['coo', 'cfo', 'president', 'md', 'director', 'vp', 'head of', 'chief'],
    academic:   ['professor', 'researcher', 'phd', 'postdoc', 'lecturer', 'faculty'],
    creative:   ['design', 'brand', 'creative', 'ux', 'product designer'],
    finance:    ['banker', 'analyst', 'pe', 'hedge fund', 'private equity', 'investment banking'],
    consultant: ['consultant', 'advisor', 'strategy', 'mckinsey', 'bcg', 'bain', 'deloitte'],
    sales:      ['sales', 'business development', 'bd', 'account', 'revenue', 'growth'],
    legal:      ['lawyer', 'attorney', 'legal', 'counsel', 'solicitor', 'barrister'],
    hr:         ['recruiter', 'talent', 'hr', 'people ops', 'hiring manager'],
};

// Goal intent → which roles to boost
const GOAL_INTENT_ROLES = {
    fundraise: ['investor', 'founder'],
    hire:      ['engineer', 'hr', 'operator'],
    market:    ['sales', 'operator', 'founder'],
    advisor:   ['consultant', 'investor', 'academic'],
    intro:     ['investor', 'founder', 'operator'],
};

/**
 * Score a contact's relevance to a goal text (0–100).
 * Pure function — no side effects.
 *
 * Scoring:
 *   - Role match for detected goal intent: up to 40 pts
 *   - Keyword overlap between goal text and contact metadata: up to 40 pts
 *   - Warmth bonus (relationship score / 5): up to 20 pts
 *
 * @param {Object} contact - contact summary (name, company, position, apollo, relationshipScore)
 * @param {string} goalText
 * @returns {number} 0–100
 */
function scoreContactForGoal(contact, goalText) {
    if (!goalText || !contact) return 0;

    const lower = goalText.toLowerCase();

    // Build searchable text from contact metadata
    const contactText = [
        contact.name || '',
        contact.company || '',
        contact.position || '',
        (contact.apollo && contact.apollo.headline) || '',
        (contact.apollo && contact.apollo.industry) || '',
        (contact.sources && contact.sources.linkedin && contact.sources.linkedin.company) || '',
        (contact.sources && contact.sources.linkedin && contact.sources.linkedin.position) || '',
    ].join(' ').toLowerCase();

    let score = 0;

    // Detect goal intent from goal text
    const isFundraise = /\b(fund|raise|invest|round|capital|vc|seed|series|angel|pitch)\b/.test(lower);
    const isHire      = /\b(hire|hiring|recruit|talent|engineer|developer|cto|coo|team)\b/.test(lower);
    const isMarket    = /\b(market|sales|customer|client|business|expansion|growth|revenue)\b/.test(lower);
    const isAdvisor   = /\b(advisor|advice|mentor|expert|consult|strategy)\b/.test(lower);

    let intentRoles = [];
    if (isFundraise) intentRoles = intentRoles.concat(GOAL_INTENT_ROLES.fundraise);
    if (isHire)      intentRoles = intentRoles.concat(GOAL_INTENT_ROLES.hire);
    if (isMarket)    intentRoles = intentRoles.concat(GOAL_INTENT_ROLES.market);
    if (isAdvisor)   intentRoles = intentRoles.concat(GOAL_INTENT_ROLES.advisor);

    // Role match score (up to 40)
    if (intentRoles.length > 0) {
        for (const role of new Set(intentRoles)) {
            const signals = GOAL_ROLE_SIGNALS[role] || [];
            if (signals.some(s => contactText.includes(s))) {
                score += 40;
                break; // only count once per contact
            }
        }
    }

    // Keyword overlap: extract meaningful words from goal text
    const stopWords = new Set([
        'raise', 'find', 'hire', 'need', 'want', 'help', 'with', 'into', 'that', 'from',
        'for', 'and', 'the', 'our', 'my', 'get', 'use', 'make', 'have', 'some', 'are',
        'can', 'who', 'new', 'all', 'not', 'any', 'but', 'how',
    ]);
    const goalWords = lower.split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
    const matchCount = goalWords.filter(w => contactText.includes(w)).length;
    score += Math.min(40, matchCount * 12);

    // Warmth bonus: relationship score is access signal (up to 20)
    score += Math.min(20, Math.round((contact.relationshipScore || 0) / 5));

    return Math.min(100, Math.round(score));
}

/**
 * Rank contacts by relevance to a goal, returning the top N.
 * Contacts with score === 0 are excluded.
 *
 * @param {Array} contacts
 * @param {string} goalText
 * @param {number} [limit=5]
 * @returns {Array} sorted by relevance desc, each augmented with goalRelevance score
 */
function rankContactsForGoal(contacts, goalText, limit = 5) {
    if (!goalText || !contacts || contacts.length === 0) return [];

    return contacts
        .filter(c => c.name && !c.isGroup)
        .map(c => ({ ...c, goalRelevance: scoreContactForGoal(c, goalText) }))
        .filter(c => c.goalRelevance > 0)
        .sort((a, b) => b.goalRelevance - a.goalRelevance || (b.relationshipScore || 0) - (a.relationshipScore || 0))
        .slice(0, limit);
}

module.exports = {
    normalizePhone,
    phoneKey,
    normalizeEmail,
    normalizeName,
    recencyScore,
    frequencyScore,
    channelScore,
    relationshipScore,
    ContactIndex,
    formatSyncAge,
    getSyncDotState,
    getOverallSyncHealth,
    healthRingColor,
    healthRingOffset,
    scoreContactForGoal,
    rankContactsForGoal,
};
