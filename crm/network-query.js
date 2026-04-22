/**
 * crm/network-query.js — Natural language network query engine
 *
 * Pure functions — no file I/O, no state.
 * Three-layer architecture:
 *   1. Pre-computed index built by crm/index.js → data/unified/query-index.json
 *   2. parseQuery + filterIndex — instant < 50ms
 *   3. Claude-powered re-ranking (done in server.js via child_process)
 */

'use strict';

// ---------------------------------------------------------------------------
// Location dictionary: canonical name → list of aliases
// ---------------------------------------------------------------------------

const LOCATION_DICT = {
    // UK
    london:       ['london', 'ldn', 'greater london'],
    manchester:   ['manchester'],
    birmingham:   ['birmingham'],
    edinburgh:    ['edinburgh'],
    bristol:      ['bristol'],
    leeds:        ['leeds'],
    oxford:       ['oxford'],
    cambridge:    ['cambridge'],
    // USA
    'new york':       ['new york', 'nyc', 'new york city', 'brooklyn', 'manhattan', 'queens'],
    'san francisco':  ['san francisco', 'sf', 'bay area', 'silicon valley', 'palo alto', 'menlo park', 'mountain view'],
    'los angeles':    ['los angeles', 'la', 'l.a.', 'santa monica'],
    chicago:          ['chicago'],
    boston:           ['boston'],
    seattle:          ['seattle'],
    austin:           ['austin'],
    miami:            ['miami'],
    washington:       ['washington', 'washington dc', 'dc', 'd.c.'],
    denver:           ['denver'],
    atlanta:          ['atlanta'],
    dallas:           ['dallas'],
    // Europe
    paris:            ['paris'],
    berlin:           ['berlin'],
    amsterdam:        ['amsterdam'],
    stockholm:        ['stockholm'],
    zurich:           ['zurich', 'zürich'],
    munich:           ['munich', 'münchen'],
    barcelona:        ['barcelona'],
    madrid:           ['madrid'],
    lisbon:           ['lisbon', 'lisboa'],
    vienna:           ['vienna', 'wien'],
    copenhagen:       ['copenhagen'],
    helsinki:         ['helsinki'],
    brussels:         ['brussels', 'bruxelles'],
    milan:            ['milan', 'milano'],
    rome:             ['rome', 'roma'],
    warsaw:           ['warsaw', 'warszawa'],
    // MENA
    dubai:            ['dubai'],
    'abu dhabi':      ['abu dhabi'],
    riyadh:           ['riyadh'],
    'tel aviv':       ['tel aviv', 'israel'],
    // Asia
    singapore:        ['singapore', 'sg'],
    'hong kong':      ['hong kong', 'hk'],
    tokyo:            ['tokyo'],
    beijing:          ['beijing'],
    shanghai:         ['shanghai'],
    bangalore:        ['bangalore', 'bengaluru'],
    mumbai:           ['mumbai', 'bombay'],
    delhi:            ['delhi', 'new delhi'],
    seoul:            ['seoul'],
    taipei:           ['taipei'],
    // Australia / NZ
    sydney:           ['sydney'],
    melbourne:        ['melbourne'],
    auckland:         ['auckland'],
    // Canada
    toronto:          ['toronto'],
    vancouver:        ['vancouver'],
    montreal:         ['montreal'],
    // Country-level fallbacks
    uk:               ['uk', 'united kingdom', 'britain', 'england'],
    us:               ['us', 'usa', 'united states', 'america'],
    germany:          ['germany', 'deutschland'],
    france:           ['france'],
    india:            ['india'],
    australia:        ['australia'],
    canada:           ['canada'],
    switzerland:      ['switzerland'],
    netherlands:      ['netherlands', 'holland'],
};

/** Build reverse lookup: alias → canonical city name */
function buildLocationAliasMap(dict) {
    const map = {};
    for (const [canonical, aliases] of Object.entries(dict)) {
        map[canonical] = canonical;
        for (const alias of aliases) {
            map[alias] = canonical;
        }
    }
    return map;
}

const LOCATION_ALIAS_MAP = buildLocationAliasMap(LOCATION_DICT);

// Sorted by length descending so longer aliases match before shorter substrings
const LOCATION_ALIASES_SORTED = Object.keys(LOCATION_ALIAS_MAP).sort((a, b) => b.length - a.length);

// ---------------------------------------------------------------------------
// Role categories
// ---------------------------------------------------------------------------

const ROLE_PATTERNS = [
    { role: 'founder',    keywords: ['founder', 'co-founder', 'cofounder', 'co founder', 'started'] },
    { role: 'investor',   keywords: ['investor', 'vc', 'venture capital', 'angel', 'fund', 'capital', 'portfolio', 'general partner'] },
    { role: 'engineer',   keywords: ['engineer', 'developer', 'software', 'cto', 'tech lead', 'engineering', 'programmer', 'architect'] },
    { role: 'operator',   keywords: ['ceo', 'coo', 'president', 'director', 'vp', 'head of', 'general manager', 'managing director'] },
    { role: 'academic',   keywords: ['professor', 'researcher', 'phd', 'postdoc', 'lecturer', 'research', 'scientist', 'academic'] },
    { role: 'creative',   keywords: ['design', 'brand', 'creative', 'ux', 'product designer', 'art director', 'graphic'] },
    { role: 'finance',    keywords: ['banker', 'private equity', 'hedge fund', 'cfo', 'finance', 'financial', 'investment banking', 'wealth'] },
    { role: 'consultant', keywords: ['consultant', 'advisor', 'advisory', 'strategy', 'mckinsey', 'bcg', 'bain', 'deloitte', 'accenture', 'kpmg', 'pwc'] },
    { role: 'sales',      keywords: ['sales', 'account executive', 'business development', 'growth', 'revenue', 'partnerships'] },
    { role: 'product',    keywords: ['product manager', 'product lead', 'cpo', 'head of product'] },
    { role: 'legal',      keywords: ['lawyer', 'attorney', 'legal', 'counsel', 'solicitor', 'barrister'] },
    { role: 'hr',         keywords: ['recruiter', 'recruiting', 'talent', 'people ops', 'human resources'] },
];

// ---------------------------------------------------------------------------
// Seniority tiers
// ---------------------------------------------------------------------------

const SENIORITY_TIERS = [
    { tier: 'c-suite', rank: 5, keywords: ['ceo', 'cto', 'cfo', 'coo', 'cpo', 'founder', 'co-founder', 'cofounder', 'president', 'owner', 'managing partner', 'general partner'] },
    { tier: 'vp',      rank: 4, keywords: ['vp', 'vice president', 'vice-president'] },
    { tier: 'director', rank: 3, keywords: ['director', 'head of', 'principal', 'managing director', 'md'] },
    { tier: 'manager',  rank: 2, keywords: ['manager', 'lead', 'senior', 'sr'] },
    { tier: 'ic',       rank: 1, keywords: [] }, // default
];

// ---------------------------------------------------------------------------
// Intent signals
// ---------------------------------------------------------------------------

const INTENT_PATTERNS = [
    { intent: 'meet',
      keywords: ['should meet', 'worth meeting', 'meet up', 'could meet', 'great to meet', 'good to meet', 'would like to meet', 'should i meet'] },
    { intent: 'reconnect',
      keywords: ["haven't spoken", "haven't talked", 'dormant', 'lost touch', 'reconnect', "haven't been in touch", 'out of touch', "haven't heard", "haven't reached", 'fallen off', 'been a while'] },
    { intent: 'intro',
      keywords: ['intro to', 'intro me', 'connect me', 'who can help me', 'introduction to', 'put me in touch', 'warm intro', 'introduce me'] },
    { intent: 'find',
      keywords: ['who do i know', 'who in my network', 'find me', 'show me', 'list', 'any '] },
];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Extract canonical city/country names from a query string.
 * Uses longest-match-first to avoid "india" matching inside "indiana".
 * @param {string} lower - lowercased query string
 * @returns {string[]} - array of canonical location names
 */
function extractLocations(lower) {
    const found = new Set();
    for (const alias of LOCATION_ALIASES_SORTED) {
        const idx = lower.indexOf(alias);
        if (idx === -1) continue;
        // Check word boundaries: char before and after should not be a letter
        const before = idx === 0 ? '' : lower[idx - 1];
        const after  = idx + alias.length >= lower.length ? '' : lower[idx + alias.length];
        if (/[a-z]/.test(before) || /[a-z]/.test(after)) continue;
        found.add(LOCATION_ALIAS_MAP[alias]);
    }
    return [...found];
}

/**
 * Extract role categories from a query string.
 * @param {string} lower - lowercased query string
 * @returns {string[]} - array of role category names
 */
function extractRoles(lower) {
    const found = new Set();
    for (const { role, keywords } of ROLE_PATTERNS) {
        for (const kw of keywords) {
            if (lower.includes(kw)) { found.add(role); break; }
        }
    }
    return [...found];
}

/**
 * Extract query intent from signals in the query string.
 * @param {string} lower - lowercased query string
 * @returns {'meet'|'reconnect'|'intro'|'find'}
 */
function extractIntent(lower) {
    for (const { intent, keywords } of INTENT_PATTERNS) {
        for (const kw of keywords) {
            if (lower.includes(kw)) return intent;
        }
    }
    return 'find';
}

/**
 * Parse a natural language query into structured filter params.
 * @param {string} q
 * @returns {{ locations: string[], roles: string[], intent: string, raw: string }}
 */
function parseQuery(q) {
    if (!q || typeof q !== 'string') return { locations: [], roles: [], intent: 'find', raw: q || '' };
    const lower = q.toLowerCase();
    return {
        locations: extractLocations(lower),
        roles:     extractRoles(lower),
        intent:    extractIntent(lower),
        raw:       q,
    };
}

// ---------------------------------------------------------------------------
// Contact field extraction (for index building)
// ---------------------------------------------------------------------------

/**
 * Check if a string contains `kw` at a word boundary.
 * Prevents "director" from matching "cto", "senior" from matching "engineer", etc.
 */
function matchesWord(str, kw) {
    const idx = str.indexOf(kw);
    if (idx === -1) return false;
    const before = idx > 0 ? str[idx - 1] : '';
    const after  = idx + kw.length < str.length ? str[idx + kw.length] : '';
    return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/**
 * Resolve seniority tier from a job title string.
 * @param {string} title
 * @returns {{ tier: string, rank: number }}
 */
function getSeniorityTier(title) {
    if (!title) return { tier: 'ic', rank: 1 };
    const lower = title.toLowerCase();
    for (const { tier, rank, keywords } of SENIORITY_TIERS) {
        if (keywords.some(kw => matchesWord(lower, kw))) return { tier, rank };
    }
    return { tier: 'ic', rank: 1 };
}

/**
 * Extract role categories from a job title string.
 * @param {string} title
 * @returns {string[]}
 */
function getRolesFromTitle(title) {
    if (!title) return [];
    const lower = title.toLowerCase();
    const found = new Set();
    for (const { role, keywords } of ROLE_PATTERNS) {
        for (const kw of keywords) {
            if (lower.includes(kw)) { found.add(role); break; }
        }
    }
    return [...found];
}

// Country-level canonicals — should only match as fallback when no city is found
const COUNTRY_CANONICALS = new Set(['uk', 'us', 'germany', 'france', 'india', 'australia', 'canada', 'switzerland', 'netherlands']);

// City → parent country, derived from LOCATION_DICT + a small supplement for cities
// whose country isn't in COUNTRY_CANONICALS (e.g. dubai→uae, singapore→singapore).
// Used in filterIndex: "uk" contacts are compatible with "london" queries.
const CITY_TO_COUNTRY = (() => {
    const SUPPLEMENT = {
        dubai: 'uae', 'abu dhabi': 'uae', riyadh: 'saudi arabia',
        'tel aviv': 'israel', 'hong kong': 'hong kong',
        singapore: 'singapore', tokyo: 'japan', beijing: 'china', shanghai: 'china',
        seoul: 'south korea', taipei: 'taiwan',
    };
    const map = { ...SUPPLEMENT };
    // For each non-country canonical in LOCATION_DICT, find its parent country in LOCATION_ALIAS_MAP
    // by checking if any alias of the city also appears in a country's alias list.
    // Simpler: manually map UK/US/EU cities using COUNTRY_CANONICALS as a guide.
    const CITY_COUNTRY_MAP = {
        // UK
        london: 'uk', manchester: 'uk', birmingham: 'uk', edinburgh: 'uk',
        bristol: 'uk', leeds: 'uk', oxford: 'uk', cambridge: 'uk', glasgow: 'uk',
        // USA
        'new york': 'us', 'san francisco': 'us', 'los angeles': 'us',
        chicago: 'us', boston: 'us', seattle: 'us', austin: 'us',
        miami: 'us', washington: 'us', denver: 'us', atlanta: 'us', dallas: 'us',
        // Europe (countries that are in COUNTRY_CANONICALS)
        berlin: 'germany', munich: 'germany', hamburg: 'germany',
        paris: 'france',
        amsterdam: 'netherlands',
        zurich: 'switzerland',
        toronto: 'canada', vancouver: 'canada', montreal: 'canada',
        sydney: 'australia', melbourne: 'australia', auckland: 'australia',
        bangalore: 'india', mumbai: 'india', delhi: 'india', 'new delhi': 'india',
    };
    return { ...map, ...CITY_COUNTRY_MAP };
})();

// ---------------------------------------------------------------------------
// Phone-number → location inference
// ---------------------------------------------------------------------------

// Phone country code → canonical location name (city where known, else country)
const PHONE_PREFIX_MAP = [
    // UK area codes (checked before generic +44)
    { prefix: '+44020',  loc: 'london' },
    { prefix: '+44028',  loc: 'london' },   // 028 is NI but close enough
    { prefix: '+440161', loc: 'manchester' },
    { prefix: '+440121', loc: 'birmingham' },
    { prefix: '+440113', loc: 'leeds' },
    { prefix: '+440141', loc: 'glasgow' },
    { prefix: '+440131', loc: 'edinburgh' },
    { prefix: '+440117', loc: 'bristol' },
    { prefix: '+440114', loc: 'sheffield' },
    { prefix: '+440116', loc: 'leicester' },
    { prefix: '+440115', loc: 'nottingham' },
    { prefix: '+44',     loc: 'uk' },
    // USA/Canada — default to us (can't distinguish without more digits)
    { prefix: '+1',      loc: 'us' },
    // Europe
    { prefix: '+33',     loc: 'france' },
    { prefix: '+49',     loc: 'germany' },
    { prefix: '+34',     loc: 'spain' },
    { prefix: '+39',     loc: 'italy' },
    { prefix: '+31',     loc: 'netherlands' },
    { prefix: '+32',     loc: 'belgium' },
    { prefix: '+41',     loc: 'switzerland' },
    { prefix: '+43',     loc: 'austria' },
    { prefix: '+46',     loc: 'sweden' },
    { prefix: '+47',     loc: 'norway' },
    { prefix: '+45',     loc: 'denmark' },
    { prefix: '+48',     loc: 'poland' },
    { prefix: '+351',    loc: 'portugal' },
    { prefix: '+30',     loc: 'greece' },
    { prefix: '+36',     loc: 'hungary' },
    { prefix: '+40',     loc: 'romania' },
    { prefix: '+7',      loc: 'russia' },
    // Middle East
    { prefix: '+971',    loc: 'uae' },
    { prefix: '+972',    loc: 'israel' },
    { prefix: '+974',    loc: 'qatar' },
    { prefix: '+973',    loc: 'bahrain' },
    { prefix: '+966',    loc: 'saudi arabia' },
    { prefix: '+20',     loc: 'egypt' },
    // Asia
    { prefix: '+91',     loc: 'india' },
    { prefix: '+86',     loc: 'china' },
    { prefix: '+81',     loc: 'japan' },
    { prefix: '+82',     loc: 'south korea' },
    { prefix: '+65',     loc: 'singapore' },
    { prefix: '+60',     loc: 'malaysia' },
    { prefix: '+66',     loc: 'thailand' },
    { prefix: '+84',     loc: 'vietnam' },
    { prefix: '+62',     loc: 'indonesia' },
    { prefix: '+63',     loc: 'philippines' },
    { prefix: '+94',     loc: 'sri lanka' },
    { prefix: '+92',     loc: 'pakistan' },
    { prefix: '+880',    loc: 'bangladesh' },
    { prefix: '+977',    loc: 'nepal' },
    // Oceania
    { prefix: '+61',     loc: 'australia' },
    { prefix: '+64',     loc: 'new zealand' },
    // Americas
    { prefix: '+55',     loc: 'brazil' },
    { prefix: '+52',     loc: 'mexico' },
    { prefix: '+54',     loc: 'argentina' },
    { prefix: '+57',     loc: 'colombia' },
    { prefix: '+56',     loc: 'chile' },
    { prefix: '+27',     loc: 'south africa' },
];

// UK local landline prefixes (without +44) → city
const UK_LOCAL_MAP = [
    { prefix: '020',  loc: 'london' },
    { prefix: '0161', loc: 'manchester' },
    { prefix: '0121', loc: 'birmingham' },
    { prefix: '0113', loc: 'leeds' },
    { prefix: '0141', loc: 'glasgow' },
    { prefix: '0131', loc: 'edinburgh' },
    { prefix: '0117', loc: 'bristol' },
    { prefix: '0114', loc: 'sheffield' },
    { prefix: '0116', loc: 'leicester' },
    { prefix: '0115', loc: 'nottingham' },
];

/**
 * Infer a canonical location from a phone number.
 * Returns null if no match.
 * @param {string} phone
 * @returns {string|null}
 */
function phoneToLocation(phone) {
    if (!phone) return null;
    // Normalise: strip spaces, dashes, parens
    const p = phone.replace(/[\s\-().]/g, '');
    // International format
    if (p.startsWith('+')) {
        for (const { prefix, loc } of PHONE_PREFIX_MAP) {
            if (p.startsWith(prefix)) return loc;
        }
    }
    // UK local format (no country code)
    for (const { prefix, loc } of UK_LOCAL_MAP) {
        if (p.startsWith(prefix)) return loc;
    }
    // UK mobile without +44: 07xxx → uk
    if (/^07\d{9}$/.test(p)) return 'uk';
    return null;
}

// Email TLD → country (only unambiguous ccTLDs)
const EMAIL_TLD_MAP = {
    '.co.uk': 'uk',
    '.org.uk': 'uk',
    '.ac.uk': 'uk',
    '.gov.uk': 'uk',
    '.de': 'germany',
    '.fr': 'france',
    '.es': 'spain',
    '.it': 'italy',
    '.nl': 'netherlands',
    '.be': 'belgium',
    '.ch': 'switzerland',
    '.at': 'austria',
    '.se': 'sweden',
    '.no': 'norway',
    '.dk': 'denmark',
    '.pl': 'poland',
    '.pt': 'portugal',
    '.gr': 'greece',
    '.au': 'australia',
    '.nz': 'new zealand',
    '.ca': 'canada',
    '.sg': 'singapore',
    '.in': 'india',
    '.jp': 'japan',
    '.cn': 'china',
    '.br': 'brazil',
    '.mx': 'mexico',
    '.ae': 'uae',
    '.il': 'israel',
    '.za': 'south africa',
};

/**
 * Infer a canonical location from an email address TLD.
 * Returns null for .com / .org / .net (not country-specific).
 * @param {string} email
 * @returns {string|null}
 */
// Precomputed: longer TLDs first so .co.uk matches before .uk
const EMAIL_TLD_SORTED = Object.keys(EMAIL_TLD_MAP).sort((a, b) => b.length - a.length);

function emailToLocation(email) {
    if (!email) return null;
    const lower = email.toLowerCase();
    for (const tld of EMAIL_TLD_SORTED) {
        if (lower.endsWith(tld)) return EMAIL_TLD_MAP[tld];
    }
    return null;
}

/**
 * Infer location from all available signals on a contact object.
 * Priority: existing Apollo/LinkedIn location > phone > email TLD.
 * @param {object} contact
 * @returns {string|null}
 */
function inferLocation(contact) {
    // 1. Already has explicit location from Apollo or LinkedIn → normalizeLocation handles it
    const explicit = contact.apollo?.location || contact.sources?.linkedin?.location || '';
    if (explicit) return null; // let normalizeLocation handle it

    // 2. Phone numbers (all sources)
    const phones = [
        ...(contact.phones || []),
        contact.sources?.googleContacts?.phones || [],
        contact.sources?.sms?.phone ? [contact.sources.sms.phone] : [],
    ].flat();
    for (const phone of phones) {
        const loc = phoneToLocation(phone);
        if (loc) return loc;
    }

    // 3. Email TLDs
    const emails = [
        ...(contact.emails || []),
        ...(contact.sources?.googleContacts?.emails || []),
        contact.sources?.email?.email ? [contact.sources.email.email] : [],
    ].flat();
    for (const email of emails) {
        const loc = emailToLocation(email);
        if (loc) return loc;
    }

    return null;
}

/**
 * Normalize a location string to a canonical city/country name.
 * Prioritises city-level matches over country-level matches so that
 * "London, England, United Kingdom" resolves to "london" not "uk".
 * @param {string} locationStr - e.g. "London, England, United Kingdom"
 * @returns {string|null}
 */
function normalizeLocation(locationStr) {
    if (!locationStr) return null;
    const lower = locationStr.toLowerCase();

    // Pass 1: city-level matches only
    for (const alias of LOCATION_ALIASES_SORTED) {
        const canonical = LOCATION_ALIAS_MAP[alias];
        if (COUNTRY_CANONICALS.has(canonical)) continue;
        if (lower.includes(alias)) return canonical;
    }

    // Pass 2: country-level fallback
    for (const alias of LOCATION_ALIASES_SORTED) {
        const canonical = LOCATION_ALIAS_MAP[alias];
        if (!COUNTRY_CANONICALS.has(canonical)) continue;
        if (lower.includes(alias)) return canonical;
    }

    return null;
}

/**
 * Compute meetScore for a contact.
 * meetScore = (relationshipScore × 0.5) + (seniority_bonus × 0.3) + (recency_penalty × 0.2)
 * recency_penalty: 100 if >60d (prioritise dormant), 50 if 30–60d, 0 if <30d
 * High meetScore = strong relationship + senior person + haven't spoken recently = ideal to reconnect.
 *
 * @param {{ relationshipScore: number, daysSinceContact: number|null, title: string }} contact
 * @returns {number} 0–100
 */
function buildMeetScore({ relationshipScore = 0, daysSinceContact = null, title = '' }) {
    const seniority = getSeniorityTier(title);
    const seniorityBonus = { 'c-suite': 100, vp: 80, director: 60, manager: 40, ic: 20 }[seniority.tier] || 20;
    const d = daysSinceContact;
    const recencyPenalty = (d === null || d === undefined) ? 50 : d > 60 ? 100 : d > 30 ? 50 : 0;
    return Math.round(relationshipScore * 0.5 + seniorityBonus * 0.3 + recencyPenalty * 0.2);
}

/**
 * Extract structured index fields from a raw contact object.
 * Does NOT compute meetScore (call buildMeetScore separately).
 * @param {object} contact
 * @returns {object}
 */
function extractContactFields(contact) {
    const title = contact.apollo?.headline ||
        contact.sources?.linkedin?.position ||
        contact.sources?.googleContacts?.title || '';
    const company = contact.sources?.linkedin?.company ||
        contact.sources?.googleContacts?.org ||
        (contact.apollo?.employmentHistory?.[0]?.organization_name) || '';
    const locationStr = contact.apollo?.location ||
        contact.sources?.linkedin?.location || '';
    const seniority = getSeniorityTier(title);

    // Priority: explicit text location → phone/email inference
    const loc = normalizeLocation(locationStr) || inferLocation(contact);

    return {
        id:               contact.id,
        name:             contact.name || '',
        title,
        company,
        city:             loc,
        roles:            getRolesFromTitle(title),
        seniority:        seniority.tier,
        seniority_rank:   seniority.rank,
        relationshipScore: contact.relationshipScore || 0,
        daysSinceContact: contact.daysSinceContact ?? null,
        interactionCount: contact.interactionCount || 0,
    };
}

/**
 * Build a complete index entry from a contact, including meetScore.
 * @param {object} contact
 * @returns {object}
 */
function buildIndexEntry(contact) {
    const entry = extractContactFields(contact);
    entry.meetScore = buildMeetScore({
        relationshipScore: entry.relationshipScore,
        daysSinceContact:  entry.daysSinceContact,
        title:             entry.title,
    });
    return entry;
}

// ---------------------------------------------------------------------------
// Filter & sort
// ---------------------------------------------------------------------------

/**
 * Filter and sort the pre-computed index based on a parsed query.
 * Returns top 20 candidates for the Claude layer.
 * @param {object[]} index
 * @param {{ locations: string[], roles: string[], intent: string }} parsed
 * @returns {object[]}
 */
function filterIndex(index, parsed) {
    let results = index;

    // Location: soft filter — keep contacts whose location matches OR is unknown.
    // Also treat country-level matches as compatible with city queries (uk ⊇ london).
    if (parsed.locations.length > 0) {
        const parentCountries = new Set(
            parsed.locations.map(l => CITY_TO_COUNTRY[l]).filter(Boolean)
        );
        results = results.filter(c =>
            !c.city ||  // unknown location → include (don't exclude)
            parsed.locations.some(l => c.city === l) || // exact city match
            (c.city && parentCountries.has(c.city))     // country includes queried city (uk ⊇ london)
        );
    }

    // Role filter: still hard — "founders" means founders, not everyone
    if (parsed.roles.length > 0) {
        results = results.filter(c =>
            parsed.roles.some(r => c.roles.includes(r))
        );
    }

    // Base score by intent
    function baseScore(c) {
        switch (parsed.intent) {
            case 'meet':      return c.meetScore;
            case 'reconnect': return c.daysSinceContact || 0;
            case 'intro':     return c.seniority_rank * 20;
            default:          return c.relationshipScore;
        }
    }

    // Location boost: confirmed match → +1000 (always sorts before unknowns)
    function locationBoost(c) {
        if (parsed.locations.length === 0) return 0;
        return parsed.locations.some(l => c.city === l) ? 1000 : 0;
    }

    const sorted = results.slice().sort((a, b) =>
        (locationBoost(b) + baseScore(b)) - (locationBoost(a) + baseScore(a))
    );

    return sorted.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Describe a parsed query in human-readable terms (for UI banner)
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable description of a parsed query.
 * @param {{ locations: string[], roles: string[], intent: string }} parsed
 * @returns {string}
 */
function describeQuery(parsed) {
    const parts = [];
    if (parsed.roles.length > 0)     parts.push(parsed.roles.join('/') + 's');
    if (parsed.locations.length > 0) parts.push('in ' + parsed.locations.map(l => l.charAt(0).toUpperCase() + l.slice(1)).join(' or '));
    const intentLabel = {
        meet:      'sorted by who you should meet',
        reconnect: 'sorted by longest since you spoke',
        intro:     'sorted by seniority',
        find:      'sorted by relationship strength',
    }[parsed.intent] || 'sorted by relationship strength';
    const showing = parts.length > 0 ? 'Showing ' + parts.join(' ') : 'Showing all contacts';
    const locationNote = parsed.locations.length > 0 ? ' (confirmed location first, then unlocated)' : '';
    return `${showing} · ${intentLabel}${locationNote}`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    parseQuery,
    filterIndex,
    extractLocations,
    extractRoles,
    extractIntent,
    buildMeetScore,
    buildIndexEntry,
    extractContactFields,
    phoneToLocation,
    emailToLocation,
    inferLocation,
    getSeniorityTier,
    getRolesFromTitle,
    normalizeLocation,
    describeQuery,
    LOCATION_ALIAS_MAP,
    ROLE_PATTERNS,
    SENIORITY_TIERS,
    INTENT_PATTERNS,
};
