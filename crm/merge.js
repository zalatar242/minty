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
const { createContact, createInteraction } = require('./schema');

const DATA = path.join(__dirname, '../data');

function load(filepath) {
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function normalizePhone(phone) {
    if (!phone) return null;
    let p = phone.replace(/[^0-9+]/g, '');
    // Convert international dialing prefix (011...) to + format
    if (p.startsWith('011') && p.length > 11) p = '+' + p.slice(3);
    return p;
}

// Normalize a name to "firstname lastname" (first two words, lowercased)
// Used for fuzzy cross-source name matching
function normalizeName(name) {
    if (!name) return null;
    const words = name.toLowerCase().trim().split(/\s+/);
    return words.slice(0, 2).join(' ');
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

function normalizeEmail(email) {
    if (!email) return null;
    return email.toLowerCase().trim();
}

// --- Indexing helpers ---

class ContactIndex {
    constructor() {
        this.contacts = [];
        this.byId    = {};   // id -> contact
        this.byPhone = {};   // normalizedPhone -> contact
        this.byEmail = {};   // normalizedEmail -> contact
        this.byName  = {};   // lowerName -> contact
        this._nextId = 1;
    }

    // Fallback sequential ID for contacts whose source has no stable identifier
    _newId() { return `c_${String(this._nextId++).padStart(4, '0')}`; }

    find(phones, emails, name) {
        for (const p of phones) {
            const n = normalizePhone(p);
            if (n && this.byPhone[n]) return this.byPhone[n];
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
            const n = normalizePhone(p);
            if (n) this.byPhone[n] = contact;
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

    // stableId: caller-supplied ID derived from source data (preferred over sequential)
    upsert(phones, emails, name, stableId = null) {
        let c = this.find(phones, emails, name);
        if (!c) {
            c = createContact(stableId || this._newId());
            this.add(c);
        }
        // Merge new phones/emails in
        for (const p of phones) {
            const n = normalizePhone(p);
            if (n && !c.phones.includes(n)) {
                c.phones.push(n);
                this.byPhone[n] = c;
            }
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

// --- Stable ID derivation ---

// "15551234567@c.us" -> "wa_15551234567"
function waStableId(number) {
    return number ? `wa_${number}` : null;
}

// "https://www.linkedin.com/in/nicolo-m" -> "li_nicolo-m"
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
    for (const [id, c] of Object.entries(contacts)) {
        // @lid entries are WhatsApp internal device IDs, not real phone numbers
        const isLid = id.endsWith('@lid');
        const phone = (!isLid && c.number) ? `+${c.number}` : null;
        const stableId = !isLid ? waStableId(c.number) : null;
        const contact = index.upsert(phone ? [phone] : [], [], c.name, stableId);
        // Keep first source data — @lid entries for the same person are merged by name
        if (!contact.sources.whatsapp) contact.sources.whatsapp = { id, ...c };
        if (!contact.name) contact.name = c.name;
    }
    console.log(`Merged ${Object.keys(contacts).length} WhatsApp contacts`);
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
    const overridesPath = path.join(DATA, 'unified/match_overrides.json');
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

// --- Main ---

function run() {
    const outDir = path.join(DATA, 'unified');
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

    const now = new Date().toISOString();
    index.contacts.forEach(c => { c.updatedAt = now; });

    fs.writeFileSync(
        path.join(outDir, 'contacts.json'),
        JSON.stringify(index.contacts, null, 2)
    );
    console.log(`\nUnified contacts: ${index.contacts.length} → data/unified/contacts.json`);

    const interactions = buildInteractions();
    fs.writeFileSync(
        path.join(outDir, 'interactions.json'),
        JSON.stringify(interactions, null, 2)
    );
    console.log(`Unified interactions: ${interactions.length} → data/unified/interactions.json`);
}

run();
