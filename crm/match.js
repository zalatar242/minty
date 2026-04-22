/**
 * Cross-source contact matching.
 * Follows crm/MATCHING.md — blocks by first name, scores pairs, writes match_overrides.json.
 *
 * Covers: WhatsApp↔LinkedIn, LinkedIn↔SMS, LinkedIn↔GoogleContacts
 *
 * Usage: node crm/match.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA = process.env.CRM_DATA_DIR || path.join(__dirname, '../data');
const OUT_DIR = process.env.CRM_OUT_DIR || path.join(DATA, 'unified');
const OVERRIDES_PATH = path.join(OUT_DIR, 'match_overrides.json');

// Very common first names → lower confidence without corroboration
const COMMON_NAMES = new Set([
    'ali', 'james', 'sara', 'sarah', 'john', 'michael', 'david', 'daniel', 'alex',
    'emma', 'sophie', 'emily', 'jessica', 'hannah', 'rachel', 'laura', 'anna',
    'liam', 'noah', 'oliver', 'harry', 'thomas', 'george', 'jack', 'charlie',
    'adam', 'sam', 'ryan', 'lucas', 'luke', 'max', 'jake', 'ben', 'chris',
    'kevin', 'mark', 'paul', 'simon', 'peter', 'robert', 'richard', 'andrew',
    'priya', 'neha', 'rahul', 'amit', 'raj', 'riya', 'pooja', 'aman', 'ananya',
    'aryan', 'ayush', 'siddharth', 'kiran', 'deepak', 'arun', 'kavya', 'divya',
    'shreya', 'nikita', 'vijay', 'suresh', 'ramesh', 'rohit', 'rohan',
    'ishaan', 'ishan', 'aditya', 'shubham', 'harsh', 'tushar', 'varun',
    'nikhil', 'mohit', 'ankit', 'sumit', 'gaurav', 'vikas', 'saurabh', 'sachin',
    'yash', 'aarav', 'ishita', 'tanvi', 'riddhi', 'ruhi', 'tanushree',
    'aaron', 'lauren', 'scott', 'jason', 'brandon', 'tyler', 'nathan', 'ethan',
    'leon', 'felix', 'julian', 'florian', 'jan', 'niklas', 'moritz', 'lukas',
    'marie', 'lea', 'lisa', 'julia', 'lena', 'maria', 'elena', 'sofia', 'victoria',
    'carlos', 'juan', 'jorge', 'miguel', 'pedro', 'mateo', 'santiago',
    'wei', 'yang', 'hong', 'lei', 'jing', 'fang', 'min', 'xin',
    'rafi', 'ahmed', 'omar', 'hassan', 'fatima', 'layla', 'maryam',
    'will', 'tom', 'tim', 'ted', 'joe', 'dan', 'rob', 'mat', 'matt', 'mike',
    'ken', 'sid', 'vik', 'neil', 'neel', 'nik', 'nick',
]);

// Institution / company abbreviations to strip from WA/GC/SMS names
const INSTITUTION_ABBREVS = new Set([
    'ucl', 'mit', 'lse', 'nyu', 'iit', 'stanford', 'oxford', 'cambridge',
    'imperial', 'kcl', 'lbs', 'insead', 'hec', 'esade', 'ie',
    'cs', 'ai', 'ml', 'pm', 'eng', 'law', 'med', 'bsc', 'msc',
    'abnb', 'airbnb', 'google', 'meta', 'amazon', 'apple', 'microsoft', 'netflix',
    'ripple', 'revolut', 'wise', 'monzo', 'stripe', 'paypal',
    'bw', 'sf', 'nyc', 'la', 'ldn', 'lon', 'dubai', 'sg', 'hk',
    'apta', 'ih', 'iit', 'bits', 'nit',
]);

// Social-relation suffixes
const RELATION_WORDS = new Set([
    'uncle', 'aunty', 'auntie', 'anna', 'bawagaru', 'akka',
    'bhai', 'bhaiya', 'didi', 'bro', 'sis', 'sir', 'ma\'am', 'madam',
    'dad', 'mum', 'mom', 'papa', 'mama', 'nana', 'nani', 'dada', 'dadi',
]);

/**
 * Strip WhatsApp/GC/SMS nickname suffixes to recover the "real" name.
 * Returns { firstName, lastName, cleaned }
 */
function cleanWaName(name) {
    if (!name) return { firstName: null, lastName: null, cleaned: null };

    let s = name.replace(/\(.*?\)/g, '').trim();
    s = s.replace(/^[\u{1F300}-\u{1FFFF}]+\s*/u, '').trim();

    const words = s.split(/\s+/).filter(Boolean);
    if (!words.length) return { firstName: null, lastName: null, cleaned: null };

    let kept = [...words];
    while (kept.length > 1) {
        const last = kept[kept.length - 1].toLowerCase().replace(/[^a-z]/g, '');
        const original = kept[kept.length - 1];
        if (
            INSTITUTION_ABBREVS.has(last) ||
            RELATION_WORDS.has(last) ||
            (original === original.toUpperCase() && original.length <= 6 && /^[A-Z0-9]+$/.test(original))
        ) {
            kept.pop();
        } else {
            break;
        }
    }

    const firstName = kept[0] ? kept[0].toLowerCase() : null;
    const lastName = kept.length > 1 ? kept.slice(1).join(' ').toLowerCase() : null;
    const cleaned = kept.join(' ').toLowerCase();

    return { firstName, lastName, cleaned, words: kept };
}

/**
 * Extract a clean first name from a LinkedIn/Email name.
 * Handles: "🦔 sam jones", "Alex Rivera 山田", "Jamie (JJ) Patel"
 */
function cleanLiName(name) {
    if (!name) return { firstName: null, lastName: null, cleaned: null };

    let s = name.replace(/^[\u{1F300}-\u{1FFFF}\u{2600}-\u{26FF}]+\s*/u, '').trim();

    let nickname = null;
    s = s.replace(/\(([^)]+)\)/g, (_, n) => { nickname = n.toLowerCase(); return ''; }).trim();
    s = s.replace(/[\u4E00-\u9FFF\u3400-\u4DBF]+/g, '').trim();

    const words = s.split(/\s+/).filter(Boolean);
    if (!words.length) return { firstName: null, lastName: null, cleaned: null };

    const firstName = words[0].toLowerCase();
    const lastName = words.length > 1 ? words.slice(1).join(' ').toLowerCase() : null;
    const cleaned = words.join(' ').toLowerCase();

    return { firstName, lastName, cleaned, nickname, words };
}

/** Clean a name based on source type */
function cleanBySource(name, sourceKey) {
    if (sourceKey === 'linkedin' || sourceKey === 'email') return cleanLiName(name);
    return cleanWaName(name); // whatsapp, sms, googleContacts
}

/** Levenshtein distance */
function lev(a, b) {
    if (!a || !b) return 99;
    if (a === b) return 0;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i-1] === b[j-1]
                ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        }
    }
    return dp[m][n];
}

function fuzzyMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const dist = lev(a, b);
    const maxLen = Math.max(a.length, b.length);
    return dist <= Math.max(1, Math.floor(maxLen * 0.2));
}

function inferCountryFromPhone(phone) {
    const maps = [
        { code: '+44', keywords: ['uk', 'london', 'britain', 'england'] },
        { code: '+91', keywords: ['india', 'mumbai', 'delhi', 'bangalore', 'bengaluru', 'hyderabad', 'chennai', 'pune'] },
        { code: '+1',  keywords: ['usa', 'us', 'canada', 'san francisco', 'new york', 'silicon valley'] },
        { code: '+90', keywords: ['turkey', 'istanbul', 'ankara', 'türkiye'] },
        { code: '+971', keywords: ['uae', 'dubai', 'abu dhabi'] },
        { code: '+49', keywords: ['germany', 'berlin', 'munich', 'hamburg'] },
        { code: '+33', keywords: ['france', 'paris'] },
        { code: '+39', keywords: ['italy', 'milan', 'rome'] },
        { code: '+65', keywords: ['singapore'] },
        { code: '+61', keywords: ['australia', 'sydney', 'melbourne'] },
        { code: '+55', keywords: ['brazil', 'são paulo', 'sao paulo', 'rio'] },
        { code: '+86', keywords: ['china', 'beijing', 'shanghai'] },
        { code: '+60', keywords: ['malaysia', 'kuala lumpur'] },
        { code: '+92', keywords: ['pakistan', 'karachi', 'lahore'] },
    ];
    for (const m of maps) {
        if (phone.startsWith(m.code)) return m;
    }
    return null;
}

/**
 * Extract relevant fields from a contact for a given source.
 */
function getFields(contact, sourceKey) {
    const src = contact.sources[sourceKey];
    return {
        name: contact.name,
        phones: contact.phones || [],
        emails: contact.emails || [],
        company: (sourceKey === 'linkedin' ? src?.company :
                  sourceKey === 'googleContacts' ? src?.org : null) || null,
        position: sourceKey === 'linkedin' ? src?.position || null : null,
        about: sourceKey === 'whatsapp' ? src?.about || null : null,
        profileUrl: sourceKey === 'linkedin' ? src?.profileUrl || null : null,
        phone: sourceKey === 'sms' ? src?.phone || null :
               sourceKey === 'whatsapp' ? (src?.number ? `+${src.number}` : null) : null,
    };
}

/**
 * Generic pair scorer — works for any two sources.
 * Both contacts must share a first name (blocking already done by caller).
 */
function scoreGenericPair(contactA, srcA, contactB, srcB) {
    const cleanA = cleanBySource(contactA.name, srcA);
    const cleanB = cleanBySource(contactB.name, srcB);

    const reasons = [];
    let score = 0;

    // --- First name match ---
    const firstA = cleanA.firstName;
    const firstB = cleanB.firstName;
    const nickB = cleanB.nickname;

    let firstMatch = false;
    if (firstA && firstB) {
        if (firstA === firstB) {
            firstMatch = true;
            reasons.push(`First name exact: '${firstA}'`);
            score += 40;
        } else if (fuzzyMatch(firstA, firstB)) {
            firstMatch = true;
            reasons.push(`First name fuzzy: '${firstA}' ~ '${firstB}'`);
            score += 30;
        } else if (nickB && firstA === nickB) {
            firstMatch = true;
            reasons.push(`Name A matches nickname '${nickB}'`);
            score += 35;
        } else if (nickB && fuzzyMatch(firstA, nickB)) {
            firstMatch = true;
            reasons.push(`Name A fuzzy-matches nickname '${nickB}'`);
            score += 25;
        }
    }

    if (!firstMatch) return { score: 0, confidence: 'skip', reasons: ['First name mismatch'] };

    // --- Last name match ---
    const lastA = cleanA.lastName;
    const lastB = cleanB.lastName;

    if (lastA && lastB) {
        if (lastA === lastB) {
            reasons.push(`Last name exact: '${lastA}'`);
            score += 40;
        } else if (fuzzyMatch(lastA, lastB)) {
            reasons.push(`Last name fuzzy: '${lastA}' ~ '${lastB}'`);
            score += 30;
        } else {
            reasons.push(`Last name mismatch: '${lastA}' vs '${lastB}'`);
            score -= 20;
        }
    } else if (lastA && !lastB) {
        score -= 5;
    }

    // --- Company / org match ---
    const fieldsA = getFields(contactA, srcA);
    const fieldsB = getFields(contactB, srcB);
    const compA = (fieldsA.company || '').toLowerCase();
    const compB = (fieldsB.company || '').toLowerCase();

    if (compA && compB) {
        const wordsA = compA.split(/[\s,\/&]+/).filter(w => w.length > 3);
        const wordsB = compB.split(/[\s,\/&]+/).filter(w => w.length > 3);
        if (wordsA.some(w => compB.includes(w)) || wordsB.some(w => compA.includes(w))) {
            reasons.push(`Company/org match: '${fieldsA.company}' ~ '${fieldsB.company}'`);
            score += 25;
        }
    } else if (compA || compB) {
        // One side has company — check if it appears in the other contact's raw name
        const nameOther = ((compA ? contactB.name : contactA.name) || '').toLowerCase();
        const comp = (compA || compB).toLowerCase();
        const compWords = comp.split(/[\s,\/&]+/).filter(w => w.length > 3);
        for (const w of compWords) {
            if (nameOther.includes(w)) {
                reasons.push(`Company '${compA || compB}' appears in other name`);
                score += 20;
                break;
            }
        }
    }

    // --- Phone country code vs LI context ---
    const liFields = srcA === 'linkedin' ? fieldsA : (srcB === 'linkedin' ? fieldsB : null);
    const nonLiFields = srcA !== 'linkedin' ? fieldsA : fieldsB;
    const phone = nonLiFields?.phone || nonLiFields?.phones?.[0];

    if (liFields && phone) {
        const phoneCountry = inferCountryFromPhone(phone);
        if (phoneCountry) {
            const liContext = ((liFields.company || '') + ' ' + (liFields.position || '')).toLowerCase();
            if (phoneCountry.keywords.some(kw => liContext.includes(kw))) {
                reasons.push(`Phone prefix ${phoneCountry.code} consistent with LI context`);
                score += 10;
            }
        }
    }

    // --- Common name penalty ---
    if (firstA && COMMON_NAMES.has(firstA)) {
        reasons.push(`Common first name '${firstA}' — lower confidence without corroboration`);
        score -= 15;
    }

    let confidence;
    if (score >= 70) confidence = 'confirmed';
    else if (score >= 45) confidence = 'likely';
    else if (score >= 20) confidence = 'possible';
    else confidence = 'skip';

    return { score, confidence, reasons };
}

/**
 * Original WA↔LI scorer — kept for backward compat with existing override entries.
 * Delegates to scoreGenericPair.
 */
function scorePair(wa, li) {
    return scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
}

/**
 * Match two groups of contacts (each lacking the other's source) by first name.
 * Returns array of match objects with confidence/score/reasons/sourceA/sourceB.
 */
function matchGroups(groupA, srcA, groupB, srcB, locationById = {}) {
    // Build blocking index for group B by first name
    const bByFirst = {};
    for (const b of groupB) {
        const { firstName, nickname } = cleanBySource(b.name, srcB);
        const keys = new Set();
        if (firstName) keys.add(firstName);
        if (nickname) keys.add(nickname);
        for (const key of keys) {
            if (!bByFirst[key]) bByFirst[key] = [];
            bByFirst[key].push(b);
        }
    }

    let candidatePairs = 0;
    const allMatches = [];

    for (const a of groupA) {
        const { firstName } = cleanBySource(a.name, srcA);
        if (!firstName || firstName.length < 2) continue;

        const candidates = bByFirst[firstName] || [];
        for (const b of candidates) {
            candidatePairs++;
            const { score: baseScore, confidence: baseConf, reasons } = scoreGenericPair(a, srcA, b, srcB);
            if (baseConf === 'skip') continue;

            // Location bonus: if both contacts have inferred city and they agree, boost score
            let score = baseScore;
            const locA = locationById[a.id];
            const locB = locationById[b.id];
            if (locA && locB) {
                if (locA === locB) {
                    reasons.push(`Location match: both ${locA}`);
                    score += 15;
                } else {
                    // Confirmed different countries → strong negative signal
                    reasons.push(`Location mismatch: ${locA} vs ${locB}`);
                    score -= 25;
                }
            }

            let confidence;
            if (score >= 70) confidence = 'confirmed';
            else if (score >= 45) confidence = 'likely';
            else if (score >= 20) confidence = 'possible';
            else confidence = 'skip';
            if (confidence === 'skip') continue;

            allMatches.push({ confidence, score, aId: a.id, bId: b.id, aName: a.name, bName: b.name, reason: reasons.join('; '), sourceA: srcA, sourceB: srcB });
        }
    }

    // Keep best match per A contact
    const byA = {};
    for (const m of allMatches) {
        if (!byA[m.aId] || byA[m.aId].score < m.score) byA[m.aId] = m;
    }

    // Per B contact: keep matches within 15 score points of the best
    const byB = {};
    for (const m of Object.values(byA)) {
        if (!byB[m.bId]) byB[m.bId] = [];
        byB[m.bId].push(m);
    }

    const deduped = [];
    for (const bMatches of Object.values(byB)) {
        bMatches.sort((a, b) => b.score - a.score);
        const best = bMatches[0].score;
        for (const m of bMatches) {
            if (best - m.score <= 15) deduped.push(m);
        }
    }

    return { matches: deduped, candidatePairs };
}

// --- Main ---

function run() {
    console.log('Loading unified contacts...');
    let contacts = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'contacts.json'), 'utf8'));

    // Exclude the user's own contact(s)
    const usersJsonPath = path.join(__dirname, '../data/users.json');
    if (fs.existsSync(usersJsonPath)) {
        const users = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8'));
        const selfIds = new Set(Object.values(users).flatMap(u => u.selfIds || []));
        if (selfIds.size) {
            const before = contacts.length;
            contacts = contacts.filter(c => !selfIds.has(c.id));
            if (before !== contacts.length) console.log(`Excluded ${before - contacts.length} self-contact(s)`);
        }
    }

    // Load inferred location from query-index (built by npm run index)
    let locationById = {};
    const qiPath = path.join(OUT_DIR, 'query-index.json');
    if (fs.existsSync(qiPath)) {
        const qi = JSON.parse(fs.readFileSync(qiPath, 'utf8'));
        for (const entry of qi) {
            if (entry.id && entry.city) locationById[entry.id] = entry.city;
        }
        console.log(`Loaded location for ${Object.keys(locationById).length} contacts from query-index`);
    }

    // Load existing overrides
    let existing = [];
    if (fs.existsSync(OVERRIDES_PATH)) {
        existing = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    }
    const existingPairs = new Set(existing.map(o => o.ids.slice().sort().join('|')));

    const allNew = [];

    // --- WhatsApp ↔ LinkedIn ---
    {
        const waOnly = contacts.filter(c => c.sources.whatsapp && c.sources.linkedin === null && c.name && !c.isGroup);
        const liOnly = contacts.filter(c => c.sources.linkedin && c.sources.whatsapp === null && c.name && !c.isGroup);
        console.log(`WA-only: ${waOnly.length}, LI-only: ${liOnly.length}`);
        const { matches, candidatePairs } = matchGroups(waOnly, 'whatsapp', liOnly, 'linkedin', locationById);
        console.log(`  WA↔LI candidate pairs: ${candidatePairs}, matches: ${matches.length}`);
        allNew.push(...matches);
    }

    // --- LinkedIn ↔ SMS ---
    {
        const liNoSms = contacts.filter(c => c.sources.linkedin && !c.sources.sms && !c.sources.whatsapp && c.name && !c.isGroup);
        const smsNoLi = contacts.filter(c => c.sources.sms && !c.sources.linkedin && !c.sources.whatsapp && c.name && !c.isGroup);
        console.log(`LI-no-SMS: ${liNoSms.length}, SMS-no-LI: ${smsNoLi.length}`);
        const { matches, candidatePairs } = matchGroups(liNoSms, 'linkedin', smsNoLi, 'sms', locationById);
        console.log(`  LI↔SMS candidate pairs: ${candidatePairs}, matches: ${matches.length}`);
        allNew.push(...matches);
    }

    // --- LinkedIn ↔ Google Contacts ---
    {
        const liNoGc = contacts.filter(c => c.sources.linkedin && !c.sources.googleContacts && !c.sources.whatsapp && !c.sources.sms && c.name && !c.isGroup);
        const gcNoLi = contacts.filter(c => c.sources.googleContacts && !c.sources.linkedin && !c.sources.whatsapp && !c.sources.sms && c.name && !c.isGroup);
        console.log(`LI-no-GC: ${liNoGc.length}, GC-no-LI: ${gcNoLi.length}`);
        const { matches, candidatePairs } = matchGroups(liNoGc, 'linkedin', gcNoLi, 'googleContacts', locationById);
        console.log(`  LI↔GC candidate pairs: ${candidatePairs}, matches: ${matches.length}`);
        allNew.push(...matches);
    }

    // Filter out already-decided pairs
    const newMatches = allNew.filter(m => {
        const pairKey = [m.aId, m.bId].sort().join('|');
        return !existingPairs.has(pairKey);
    });

    newMatches.sort((a, b) => b.score - a.score);

    const summary = { confirmed: 0, likely: 0, possible: 0 };
    for (const m of newMatches) { if (m.confidence in summary) summary[m.confidence]++; }
    console.log(`\nNew matches: ${newMatches.length} (confirmed: ${summary.confirmed}, likely: ${summary.likely}, possible: ${summary.possible})`);

    if (newMatches.length === 0) {
        console.log('No new matches — nothing to write.');
        return;
    }

    const toWrite = newMatches.map(({ score, aId, bId, aName, bName, ...rest }) => ({
        ...rest,
        ids: [aId, bId],
        names: [aName, bName],
    }));
    const combined = [...existing, ...toWrite];
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(combined, null, 2));
    console.log(`Wrote ${combined.length} total overrides to ${OVERRIDES_PATH}`);

    console.log('\n--- Confirmed matches ---');
    newMatches.filter(m => m.confidence === 'confirmed').forEach(m => {
        console.log(`  [${m.score}] ${m.aName} (${m.sourceA}) ↔ ${m.bName} (${m.sourceB})`);
        console.log(`       ${m.reason}`);
    });

    console.log('\n--- Likely matches ---');
    newMatches.filter(m => m.confidence === 'likely').forEach(m => {
        console.log(`  [${m.score}] ${m.aName} (${m.sourceA}) ↔ ${m.bName} (${m.sourceB})`);
        console.log(`       ${m.reason}`);
    });
}

run();
