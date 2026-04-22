/**
 * Cross-source contact matching.
 * Follows crm/MATCHING.md — blocks by first name, scores pairs, writes match_overrides.json.
 *
 * Usage: node crm/match.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '../data');
const OVERRIDES_PATH = path.join(DATA, 'unified/match_overrides.json');

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

// Institution / company abbreviations to strip from WA names
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
 * Strip WhatsApp nickname suffixes to recover the "real" name.
 * Returns { firstName, lastName, cleaned } where cleaned is first+last.
 */
function cleanWaName(name) {
    if (!name) return { firstName: null, lastName: null, cleaned: null };

    // Remove parenthetical annotations: "(UCL)", "(SF, ABNB)", "(Billy)"
    let s = name.replace(/\(.*?\)/g, '').trim();

    // Remove emoji at start
    s = s.replace(/^[\u{1F300}-\u{1FFFF}]+\s*/u, '').trim();

    const words = s.split(/\s+/).filter(Boolean);
    if (!words.length) return { firstName: null, lastName: null, cleaned: null };

    // Keep stripping from the end while the last word is:
    // - all-caps (likely abbreviation), length 1-6
    // - known institution/company abbrev
    // - a relation word
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

    // If only 1 word left, it's the first name
    const firstName = kept[0] ? kept[0].toLowerCase() : null;
    const lastName = kept.length > 1 ? kept.slice(1).join(' ').toLowerCase() : null;
    const cleaned = kept.join(' ').toLowerCase();

    return { firstName, lastName, cleaned, words: kept };
}

/**
 * Extract a clean first name from a LinkedIn name.
 * Handles: "🦔 sam jones", "Alex Rivera 山田", "Jamie (JJ) Patel"
 */
function cleanLiName(name) {
    if (!name) return { firstName: null, lastName: null, cleaned: null };

    // Remove leading emoji
    let s = name.replace(/^[\u{1F300}-\u{1FFFF}\u{2600}-\u{26FF}]+\s*/u, '').trim();

    // Remove parenthetical nickname: "(JJ)"
    let nickname = null;
    s = s.replace(/\(([^)]+)\)/g, (_, n) => { nickname = n.toLowerCase(); return ''; }).trim();

    // Remove Chinese / CJK characters (they're aliases appended for context)
    s = s.replace(/[\u4E00-\u9FFF\u3400-\u4DBF]+/g, '').trim();

    const words = s.split(/\s+/).filter(Boolean);
    if (!words.length) return { firstName: null, lastName: null, cleaned: null };

    const firstName = words[0].toLowerCase();
    const lastName = words.length > 1 ? words.slice(1).join(' ').toLowerCase() : null;
    const cleaned = words.join(' ').toLowerCase();

    return { firstName, lastName, cleaned, nickname, words };
}

/** Levenshtein distance (simple) */
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

/**
 * Score a (waContact, liContact) candidate pair.
 * Returns { score, confidence, reasons }
 */
function scorePair(wa, li) {
    const waClean = cleanWaName(wa.name);
    const liClean = cleanLiName(li.name);

    const reasons = [];
    let score = 0;

    // --- First name match ---
    const waFirst = waClean.firstName;
    const liFirst = liClean.firstName;
    const liNick = liClean.nickname;

    let firstMatch = false;
    if (waFirst && liFirst) {
        if (waFirst === liFirst) {
            firstMatch = true;
            reasons.push(`First name exact: '${waFirst}'`);
            score += 40;
        } else if (fuzzyMatch(waFirst, liFirst)) {
            firstMatch = true;
            reasons.push(`First name fuzzy: '${waFirst}' ~ '${liFirst}'`);
            score += 30;
        } else if (liNick && waFirst === liNick) {
            firstMatch = true;
            reasons.push(`WA first name matches LI nickname '${liNick}'`);
            score += 35;
        } else if (liNick && fuzzyMatch(waFirst, liNick)) {
            firstMatch = true;
            reasons.push(`WA first name fuzzy-matches LI nickname '${liNick}'`);
            score += 25;
        }
    }

    if (!firstMatch) return { score: 0, confidence: 'skip', reasons: ['First name mismatch'] };

    // --- Last name match ---
    const waLast = waClean.lastName;
    const liLast = liClean.lastName;

    if (waLast && liLast) {
        if (waLast === liLast) {
            reasons.push(`Last name exact: '${waLast}'`);
            score += 40;
        } else if (fuzzyMatch(waLast, liLast)) {
            reasons.push(`Last name fuzzy: '${waLast}' ~ '${liLast}'`);
            score += 30;
        } else {
            // Last name present on both sides but mismatch — negative signal
            reasons.push(`Last name mismatch: '${waLast}' vs '${liLast}'`);
            score -= 20;
        }
    } else if (waLast && !liLast) {
        // WA has last name but LI doesn't — slight negative
        score -= 5;
    }

    // --- Company/context match ---
    const waOriginal = (wa.name || '').toLowerCase();
    const liCompany = (li.sources.linkedin.company || '').toLowerCase();
    const liPosition = (li.sources.linkedin.position || '').toLowerCase();

    if (liCompany) {
        // Check if any word of the company appears in WA name
        const companyWords = liCompany.split(/[\s,\/&]+/).filter(w => w.length > 3);
        for (const w of companyWords) {
            if (waOriginal.includes(w)) {
                reasons.push(`Company '${li.sources.linkedin.company}' appears in WA name`);
                score += 20;
                break;
            }
        }
    }

    // --- Phone country code vs. LI profile URL domain / position hints ---
    // (No location field, but we can sometimes infer from position/company)
    const waPhone = wa.phones && wa.phones[0];
    if (waPhone) {
        // +44 UK, +91 India, +1 US/CA, +90 Turkey, +971 UAE, etc.
        // Check if position/company mentions a location consistent with phone prefix
        const phoneCountry = inferCountryFromPhone(waPhone);
        if (phoneCountry) {
            const combinedLi = (liCompany + ' ' + liPosition).toLowerCase();
            if (phoneCountry.keywords.some(kw => combinedLi.includes(kw))) {
                reasons.push(`Phone prefix ${phoneCountry.code} consistent with LI context`);
                score += 10;
            }
        }
    }

    // --- Common name penalty ---
    if (waFirst && COMMON_NAMES.has(waFirst)) {
        reasons.push(`Common first name '${waFirst}' — lower confidence without corroboration`);
        score -= 15;
    }

    // --- Classify ---
    let confidence;
    if (score >= 70) confidence = 'confirmed';
    else if (score >= 45) confidence = 'likely';
    else if (score >= 20) confidence = 'possible';
    else confidence = 'skip';

    return { score, confidence, reasons };
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

// --- Main ---

function run() {
    console.log('Loading unified contacts...');
    const contacts = JSON.parse(fs.readFileSync(path.join(DATA, 'unified/contacts.json'), 'utf8'));

    const waOnly = contacts.filter(c => c.sources.whatsapp && c.sources.linkedin === null && c.name);
    const liOnly = contacts.filter(c => c.sources.linkedin && c.sources.whatsapp === null && c.name);

    console.log(`WA-only (named): ${waOnly.length}, LI-only (named): ${liOnly.length}`);

    // Block by first name (first word, lowercased, after cleaning)
    const liByFirst = {};
    for (const li of liOnly) {
        const { firstName, nickname } = cleanLiName(li.name);
        const keys = new Set();
        if (firstName) keys.add(firstName);
        if (nickname) keys.add(nickname);
        for (const key of keys) {
            if (!liByFirst[key]) liByFirst[key] = [];
            liByFirst[key].push(li);
        }
    }

    // Load existing overrides. IDs are now stable so we can use them directly for dedup.
    // Existing decisions (skip/unsure/confirmed/likely) are preserved — only new pairs are added.
    let existing = [];
    if (fs.existsSync(OVERRIDES_PATH)) {
        existing = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    }
    const existingPairs = new Set(existing.map(o => o.ids.slice().sort().join('|')));

    // Score all candidate pairs
    let candidatePairs = 0;
    const allMatches = [];

    for (const wa of waOnly) {
        const { firstName } = cleanWaName(wa.name);
        if (!firstName || firstName.length < 2) continue;

        const candidates = liByFirst[firstName] || [];
        for (const li of candidates) {
            candidatePairs++;
            const { score, confidence, reasons } = scorePair(wa, li);
            if (confidence === 'skip') continue;
            allMatches.push({
                confidence,
                score,
                waId: wa.id,
                liId: li.id,
                waName: wa.name,
                liName: li.name,
                reason: reasons.join('; '),
            });
        }
    }

    // For each WA contact, keep only the best LI match.
    // Exception: WA duplicates (same name, different IDs) may both map to the same LI contact.
    const byWa = {};
    for (const m of allMatches) {
        if (!byWa[m.waId] || byWa[m.waId].score < m.score) {
            byWa[m.waId] = m;
        }
    }

    // For each LI contact that has multiple WA matches, keep only matches within
    // 15 score points of the best (likely genuine WA duplicates of the same person).
    // Drop clearly inferior WA matches (likely false positives sharing only a first name).
    const byLi = {};
    for (const m of Object.values(byWa)) {
        if (!byLi[m.liId]) byLi[m.liId] = [];
        byLi[m.liId].push(m);
    }

    const dedupedMatches = [];
    for (const liMatches of Object.values(byLi)) {
        liMatches.sort((a, b) => b.score - a.score);
        const best = liMatches[0];
        for (const m of liMatches) {
            if (best.score - m.score <= 15) dedupedMatches.push(m);
        }
    }

    // Filter out pairs that already have a decision
    const newMatches = dedupedMatches.filter(m => {
        const pairKey = [m.waId, m.liId].sort().join('|');
        return !existingPairs.has(pairKey);
    });

    console.log(`Candidate pairs evaluated: ${candidatePairs}`);
    console.log(`New matches found: ${newMatches.length}`);

    // Sort by score desc for readability
    newMatches.sort((a, b) => b.score - a.score);

    const summary = { confirmed: 0, likely: 0, possible: 0 };
    for (const m of newMatches) {
        if (m.confidence in summary) summary[m.confidence]++;
    }
    console.log(`  confirmed: ${summary.confirmed}, likely: ${summary.likely}, possible: ${summary.possible}`);

    if (newMatches.length === 0) {
        console.log('No new matches — nothing to write.');
        return;
    }

    // Append new pairs to existing overrides — existing decisions are untouched.
    const toWrite = newMatches.map(({ score, waId, liId, waName, liName, ...rest }) => ({
        ...rest,
        ids: [waId, liId],
        names: [waName, liName],
    }));
    const combined = [...existing, ...toWrite];
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(combined, null, 2));
    console.log(`Wrote ${combined.length} total overrides to data/unified/match_overrides.json`);

    // Print confirmed/likely for quick review
    console.log('\n--- Confirmed matches ---');
    newMatches.filter(m => m.confidence === 'confirmed').forEach(m => {
        console.log(`  [${m.score}] ${m.waName} ↔ ${m.liName}`);
        console.log(`       ${m.reason}`);
    });

    console.log('\n--- Likely matches ---');
    newMatches.filter(m => m.confidence === 'likely').forEach(m => {
        console.log(`  [${m.score}] ${m.waName} ↔ ${m.liName}`);
        console.log(`       ${m.reason}`);
    });
}

run();
