/**
 * Cross-source contact merge & deduplication.
 *
 * Loads contacts from all sources, normalises them, deduplicates by
 * phone number > email > name, and writes a unified contacts file.
 *
 * Also builds a unified interactions timeline across all sources.
 *
 * Usage: node crm/merge.js
 */

const fs = require('fs');
const path = require('path');
const { createInteraction } = require('./schema');
const {
    normalizePhone,
    normalizeEmail,
    normalizeName,
    recencyScore,
    frequencyScore,
    channelScore,
    ContactIndex,
} = require('./utils');

const DATA = process.env.CRM_DATA_DIR || path.join(__dirname, '../data');

function load(filepath) {
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

// Build a map of normalizedName -> [phones] from ImportedContacts.
// These are phone-book contacts the user imported into LinkedIn — useful
// for bridging LinkedIn connections (name-only) to WhatsApp (phone-based).
function buildPhoneBridge(linkedinContacts) {
    const bridge = {}; // normalizedName -> Set of phones
    for (const c of linkedinContacts) {
        if (c.source !== 'linkedin_imported') continue;
        if (!c.phones || c.phones.length === 0) continue;
        const key = normalizeName(c.name);
        if (!key || key.length < 3) continue;
        if (!bridge[key]) bridge[key] = new Set();
        for (const p of c.phones) {
            const n = normalizePhone(p);
            if (n && n.length >= 7) bridge[key].add(n);
        }
    }
    return bridge;
}

// ContactIndex and all normalization helpers live in crm/utils.js (imported above).

// --- Stable ID derivation ---

// "15551234567@c.us" -> "wa_15551234567"
function waStableId(number) {
    return number ? `wa_${number}` : null;
}

// "https://www.linkedin.com/in/alex-r" -> "li_alex-r"
function liStableId(profileUrl) {
    if (!profileUrl) return null;
    const slug = profileUrl
        .replace(/^.*\/in\//, '')
        .replace(/\/+$/, '')
        .replace(/[^a-z0-9_-]/gi, '-')
        .toLowerCase();
    return slug ? `li_${slug}` : null;
}

// --- Source loaders ---

function loadWhatsApp(index) {
    const contacts = load(path.join(DATA, 'whatsapp/contacts.json'));
    if (!contacts) { console.log('whatsapp/contacts.json not found, skipping'); return; }
    let groups = 0;
    for (const [id, c] of Object.entries(contacts)) {
        // @lid entries are WhatsApp internal device IDs, not real phone numbers
        const isLid = id.endsWith('@lid');
        // @g.us entries are WhatsApp group chats — track separately, not as people
        const isGroup = id.endsWith('@g.us');
        const phone = (!isLid && !isGroup && c.number) ? `+${c.number}` : null;
        const stableId = !isLid ? waStableId(c.number || id.replace(/@.*/, '')) : null;
        const contact = index.upsert(phone ? [phone] : [], [], c.name, stableId);
        // Keep first source data — @lid entries for the same person are merged by name
        if (!contact.sources.whatsapp) contact.sources.whatsapp = { id, ...c };
        if (!contact.name) contact.name = c.name;
        if (isGroup) { contact.isGroup = true; groups++; }
    }
    console.log(`Merged ${Object.keys(contacts).length} WhatsApp contacts (${groups} group chats tagged)`);
}

function loadLinkedIn(index) {
    const contacts = load(path.join(DATA, 'linkedin/contacts.json'));
    if (!contacts) { console.log('linkedin/contacts.json not found, skipping'); return; }

    const phoneBridge = buildPhoneBridge(contacts);

    let connections = 0, bridged = 0;
    for (const c of contacts) {
        if (c.source === 'linkedin_imported') continue; // handled via bridge only

        const nameKey = normalizeName(c.name);
        const bridgedPhones = nameKey && phoneBridge[nameKey]
            ? [...phoneBridge[nameKey]]
            : [];
        if (bridgedPhones.length > 0) bridged++;

        const emails = c.email ? [c.email] : [];
        const stableId = liStableId(c.profileUrl);
        const contact = index.upsert(bridgedPhones, emails, c.name, stableId);
        contact.sources.linkedin = c;
        if (!contact.name && c.name) contact.name = c.name;
        connections++;
    }
    console.log(`Merged ${connections} LinkedIn connections (${bridged} with phone bridge)`);
}

function loadTelegram(index) {
    const contacts = load(path.join(DATA, 'telegram/contacts.json'));
    if (!contacts) { console.log('telegram/contacts.json not found, skipping'); return; }
    for (const c of contacts) {
        const phone = c.phone ? normalizePhone(c.phone) : null;
        const stableId = c.id ? `tg_${c.id}` : (c.username ? `tg_${c.username}` : null);
        const contact = index.upsert(phone ? [phone] : [], [], c.name, stableId);
        contact.sources.telegram = c;
        if (!contact.name && c.name) contact.name = c.name;
    }
    console.log(`Merged ${contacts.length} Telegram contacts`);
}

function loadEmail(index) {
    const contacts = load(path.join(DATA, 'email/contacts.json'));
    if (!contacts) { console.log('email/contacts.json not found, skipping'); return; }
    for (const c of contacts) {
        const stableId = c.email
            ? `email_${c.email.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
            : null;
        const contact = index.upsert([], c.email ? [c.email] : [], c.name, stableId);
        contact.sources.email = c;
        if (!contact.name && c.name) contact.name = c.name;
    }
    console.log(`Merged ${contacts.length} email contacts`);
}

function loadGoogleContacts(index) {
    const contacts = load(path.join(DATA, 'google-contacts/contacts.json'));
    if (!contacts) { console.log('google-contacts/contacts.json not found, skipping'); return; }
    for (const c of contacts) {
        const phones = (c.phones || []).map(normalizePhone).filter(Boolean);
        const emails = (c.emails || []).map(normalizeEmail).filter(Boolean);
        // Stable ID: prefer first phone, else first email
        const stableId = phones[0]
            ? `gc_${phones[0].replace(/[^0-9]/g, '')}`
            : (emails[0] ? `gc_${emails[0].replace(/[^a-z0-9]/g, '_')}` : null);
        const contact = index.upsert(phones, emails, c.name, stableId);
        if (!contact.sources.googleContacts) contact.sources.googleContacts = c;
        if (!contact.name && c.name) contact.name = c.name;
    }
    console.log(`Merged ${contacts.length} Google Contacts`);
}

function loadSms(index) {
    const contacts = load(path.join(DATA, 'sms/contacts.json'));
    if (!contacts) { console.log('sms/contacts.json not found, skipping'); return; }
    for (const c of contacts) {
        const phone = normalizePhone(c.phone);
        if (!phone) continue;
        const stableId = `sms_${phone.replace(/[^0-9]/g, '')}`;
        const contact = index.upsert([phone], [], c.name || null, stableId);
        if (!contact.sources.sms) contact.sources.sms = c;
        if (!contact.name && c.name) contact.name = c.name;
    }
    console.log(`Merged ${contacts.length} SMS contacts`);
}

// --- Interaction timeline ---

function buildInteractions() {
    const interactions = [];

    // WhatsApp
    const waChats = load(path.join(DATA, 'whatsapp/chats.json'));
    if (waChats) {
        for (const [chatName, chat] of Object.entries(waChats)) {
            for (const m of chat.messages || []) {
                interactions.push(createInteraction('whatsapp', {
                    ...m,
                    chatName,
                    chatId: chat.meta && chat.meta.id,
                }));
            }
        }
    }

    // Telegram
    const tgChats = load(path.join(DATA, 'telegram/chats.json'));
    if (tgChats) {
        for (const chat of tgChats) {
            for (const m of chat.messages || []) {
                interactions.push(createInteraction('telegram', {
                    ...m,
                    chatName: chat.name,
                    chatId: chat.id,
                }));
            }
        }
    }

    // LinkedIn messages
    const liMessages = load(path.join(DATA, 'linkedin/messages.json'));
    if (liMessages) {
        for (const conv of liMessages) {
            for (const m of conv.messages || []) {
                interactions.push(createInteraction('linkedin', {
                    ...m,
                    chatId: conv.id,
                    chatName: conv.participants.join(', '),
                }));
            }
        }
    }

    // Email
    const emailMessages = load(path.join(DATA, 'email/messages.json'));
    if (emailMessages) {
        for (const m of emailMessages) {
            interactions.push(createInteraction('email', m));
        }
    }

    // SMS
    const smsThreads = load(path.join(DATA, 'sms/messages.json'));
    if (smsThreads) {
        for (const thread of smsThreads) {
            for (const m of thread.messages || []) {
                interactions.push(createInteraction('sms', {
                    ...m,
                    chatId: thread.phone,
                    chatName: thread.contactName || thread.phone,
                    from: m.direction === 'received' ? thread.phone : 'me',
                    to: m.direction === 'sent' ? thread.phone : 'me',
                }));
            }
        }
    }

    // Sort chronologically
    interactions.sort((a, b) => {
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return new Date(a.timestamp) - new Date(b.timestamp);
    });

    return interactions;
}

// --- Apollo enrichment ---

function applyApolloEnrichment(index) {
    const enrichPath = path.join(DATA, 'apollo/enrichment.json');
    if (!fs.existsSync(enrichPath)) return;

    const enrichment = JSON.parse(fs.readFileSync(enrichPath, 'utf8'));
    let applied = 0;
    for (const [id, data] of Object.entries(enrichment)) {
        const contact = index.byId[id];
        if (!contact || data.notFound) continue;
        contact.apollo = data;
        applied++;
    }
    console.log(`Applied Apollo enrichment to ${applied} contacts`);
}

// --- Match overrides (from crm/MATCHING.md + Claude Code matching runs) ---

function applyOverrides(index) {
    const outDir = process.env.CRM_OUT_DIR || path.join(DATA, 'unified');
    const overridesPath = path.join(outDir, 'match_overrides.json');
    if (!fs.existsSync(overridesPath)) return;

    const overrides = JSON.parse(fs.readFileSync(overridesPath));
    let applied = 0, skipped = 0;

    for (const override of overrides) {
        if (!['confirmed', 'likely'].includes(override.confidence)) { skipped++; continue; }

        const [idA, idB] = override.ids;
        const a = index.byId[idA];
        const b = index.byId[idB];
        if (!a || !b || a === b) continue;

        // Merge b into a: copy sources, phones, emails
        for (const [src, val] of Object.entries(b.sources)) {
            if (val !== null && a.sources[src] === null) a.sources[src] = val;
        }
        for (const p of b.phones) {
            if (!a.phones.includes(p)) { a.phones.push(p); index.byPhone[p] = a; }
        }
        for (const e of b.emails) {
            if (!a.emails.includes(e)) { a.emails.push(e); index.byEmail[e] = a; }
        }
        if (!a.name && b.name) a.name = b.name;

        // Remove b from contacts list
        index.contacts = index.contacts.filter(c => c.id !== b.id);
        delete index.byId[b.id];
        applied++;
    }

    console.log(`Applied ${applied} overrides (${skipped} "possible" skipped — needs review)`);
}

// --- Relationship strength scoring ---

function buildInteractionIndex(interactions) {
    const idx = { byChatId: {}, byFrom: {}, byEmail: {}, byLiName: {} };
    for (const i of interactions) {
        if (i.chatId) {
            if (!idx.byChatId[i.chatId]) idx.byChatId[i.chatId] = [];
            idx.byChatId[i.chatId].push(i);
        }
        if (i.from && typeof i.from === 'string' && i.from !== 'me') {
            if (!idx.byFrom[i.from]) idx.byFrom[i.from] = [];
            idx.byFrom[i.from].push(i);
        }
        if (i.source === 'linkedin' && i.chatName) {
            for (const name of i.chatName.split(',').map(n => n.trim())) {
                if (!idx.byLiName[name]) idx.byLiName[name] = [];
                idx.byLiName[name].push(i);
            }
        }
        if (i.source === 'email') {
            const addrs = [i.from, ...(Array.isArray(i.to) ? i.to : [i.to])].filter(Boolean);
            for (const addr of addrs) {
                if (!idx.byEmail[addr]) idx.byEmail[addr] = [];
                idx.byEmail[addr].push(i);
            }
        }
    }
    return idx;
}

function getContactInteractionStats(contact, idx) {
    const seen = new Set();
    const matched = [];
    const sources = new Set();

    function add(list, source) {
        for (const i of (list || [])) {
            const key = i.id || `${i.source}:${i.timestamp}:${String(i.body || '').slice(0, 20)}`;
            if (!seen.has(key)) {
                seen.add(key);
                matched.push(i);
                sources.add(i.source);
            }
        }
    }

    if (contact.sources.whatsapp) {
        const waId = contact.sources.whatsapp.id;
        add(idx.byChatId[waId]);
        add(idx.byFrom[waId]);
    }
    if (contact.sources.linkedin && contact.sources.linkedin.name) {
        add(idx.byLiName[contact.sources.linkedin.name]);
    }
    for (const email of contact.emails) {
        add(idx.byEmail[email]);
    }
    if (contact.sources.sms) {
        const phone = contact.sources.sms.phone;
        add(idx.byChatId[phone]);
    }
    if (contact.sources.telegram && contact.sources.telegram.userId) {
        add(idx.byChatId[String(contact.sources.telegram.userId)]);
    }

    // Find most recent interaction timestamp
    let lastTs = null;
    for (const i of matched) {
        if (!i.timestamp) continue;
        const t = new Date(i.timestamp);
        if (!isNaN(t) && (!lastTs || t > lastTs)) lastTs = t;
    }

    return {
        interactionCount: matched.length,
        lastContactedAt: lastTs ? lastTs.toISOString() : null,
        activeChannels: [...sources],
    };
}

function computeRelationshipScores(index, interactions) {
    const idx = buildInteractionIndex(interactions);
    const now = Date.now();

    // Collect all interaction counts to compute frequency percentile
    // Skip group chats — they are communities, not individual relationships
    const counts = [];
    const statsMap = new Map();
    for (const contact of index.contacts) {
        if (contact.isGroup) continue;
        const stats = getContactInteractionStats(contact, idx);
        statsMap.set(contact.id, stats);
        counts.push(stats.interactionCount);
    }

    // p90 for log-normalizing frequency
    const sorted = [...counts].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 1;

    for (const contact of index.contacts) {
        if (contact.isGroup) { contact.relationshipScore = 0; continue; }
        const stats = statsMap.get(contact.id);
        contact.interactionCount = stats.interactionCount;
        contact.lastContactedAt = stats.lastContactedAt || contact.lastContactedAt || null;
        contact.activeChannels = stats.activeChannels;

        // Days since last contact
        let daysSince = null;
        if (contact.lastContactedAt) {
            daysSince = Math.floor((now - new Date(contact.lastContactedAt)) / (1000 * 60 * 60 * 24));
        }
        contact.daysSinceContact = daysSince;

        const recency = recencyScore(daysSince);
        const freq    = frequencyScore(stats.interactionCount, p90);
        const channel = channelScore(stats.activeChannels);

        contact.relationshipScore = Math.round(recency * 0.5 + freq * 0.3 + channel * 0.2);
    }

    const scored = index.contacts.filter(c => c.relationshipScore > 0).length;
    console.log(`Relationship scores computed for ${scored} contacts (p90 interaction count: ${p90})`);
    if (index._phoneCollisions > 0)
        console.log(`Phone collision merges: ${index._phoneCollisions} (contacts unified via phone-number normalization)`);
}

// --- Main ---

function run() {
    const outDir = process.env.CRM_OUT_DIR || path.join(DATA, 'unified');
    fs.mkdirSync(outDir, { recursive: true });

    const index = new ContactIndex();
    loadWhatsApp(index);
    loadLinkedIn(index);
    loadTelegram(index);
    loadEmail(index);
    loadGoogleContacts(index);
    loadSms(index);
    applyOverrides(index);
    applyApolloEnrichment(index);

    const interactions = buildInteractions();
    computeRelationshipScores(index, interactions);

    const now = new Date().toISOString();
    index.contacts.forEach(c => { c.updatedAt = now; });

    fs.writeFileSync(
        path.join(outDir, 'contacts.json'),
        JSON.stringify(index.contacts, null, 2)
    );
    console.log(`\nUnified contacts: ${index.contacts.length} → data/unified/contacts.json`);

    fs.writeFileSync(
        path.join(outDir, 'interactions.json'),
        JSON.stringify(interactions, null, 2)
    );
    console.log(`Unified interactions: ${interactions.length} → data/unified/interactions.json`);
}

run();
