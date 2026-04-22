/**
 * CRM Query Tool
 *
 * Search your unified contacts and pull up interaction history.
 *
 * Usage:
 *   node crm/query.js search "Alice"
 *   node crm/query.js contact c_0012
 *   node crm/query.js timeline c_0012
 *   node crm/query.js stats
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '../data/unified');

function load(file) {
    const p = path.join(DATA, file);
    if (!fs.existsSync(p)) {
        console.error(`Run "node crm/merge.js" first to build unified data.`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function search(query) {
    const contacts = load('contacts.json');
    const q = query.toLowerCase();
    const results = contacts.filter(c =>
        (c.name && c.name.toLowerCase().includes(q)) ||
        c.phones.some(p => p.includes(q)) ||
        c.emails.some(e => e.toLowerCase().includes(q))
    );
    if (!results.length) { console.log('No contacts found.'); return; }
    results.forEach(c => {
        const sources = Object.entries(c.sources)
            .filter(([, v]) => v !== null)
            .map(([k]) => k)
            .join(', ');
        console.log(`[${c.id}] ${c.name || '(no name)'}`);
        console.log(`  phones: ${c.phones.join(', ') || '-'}`);
        console.log(`  emails: ${c.emails.join(', ') || '-'}`);
        console.log(`  sources: ${sources}`);
        console.log('');
    });
}

function showContact(id) {
    const contacts = load('contacts.json');
    const c = contacts.find(c => c.id === id);
    if (!c) { console.log(`Contact ${id} not found.`); return; }
    console.log(JSON.stringify(c, null, 2));
}

function showTimeline(id) {
    const contacts = load('contacts.json');
    const c = contacts.find(c => c.id === id);
    if (!c) { console.log(`Contact ${id} not found.`); return; }

    const interactions = load('interactions.json');

    // Match interactions by phone/email/name
    const phones = new Set(c.phones);
    const emails = new Set(c.emails);
    const name = c.name ? c.name.toLowerCase() : null;

    const waId = c.sources.whatsapp && c.sources.whatsapp.id;
    const tgId = c.sources.telegram && c.sources.telegram.userId;

    const matched = interactions.filter(i => {
        if (i.source === 'whatsapp' && waId) {
            return i.from === waId || i.chatId === waId;
        }
        if (i.source === 'telegram' && tgId) {
            return String(i.fromId) === String(tgId);
        }
        if (i.source === 'email') {
            const fromEmail = (i.from || '').toLowerCase();
            return [...emails].some(e => fromEmail.includes(e));
        }
        if (i.source === 'linkedin') {
            return name && (i.from || '').toLowerCase().includes(name);
        }
        return false;
    });

    if (!matched.length) {
        console.log(`No interactions found for ${c.name || id}.`);
        return;
    }

    console.log(`Interaction timeline for ${c.name || id} (${matched.length} messages):\n`);
    matched.forEach(i => {
        const ts = i.timestamp ? new Date(i.timestamp).toLocaleString() : '?';
        const preview = (i.body || i.subject || '').slice(0, 80);
        console.log(`[${ts}] [${i.source}] ${preview}`);
    });
}

function showStats() {
    const contacts = load('contacts.json');
    const interactions = load('interactions.json');

    const sourceCounts = { whatsapp: 0, linkedin: 0, telegram: 0, email: 0, googleContacts: 0, sms: 0 };
    contacts.forEach(c => {
        for (const [src, val] of Object.entries(c.sources)) {
            if (val !== null) sourceCounts[src]++;
        }
    });

    const interactionsBySource = {};
    interactions.forEach(i => {
        interactionsBySource[i.source] = (interactionsBySource[i.source] || 0) + 1;
    });

    console.log('=== CRM Stats ===\n');
    console.log(`Total contacts: ${contacts.length}`);
    console.log('  By source:');
    for (const [src, n] of Object.entries(sourceCounts)) {
        console.log(`    ${src}: ${n}`);
    }
    console.log(`\nTotal interactions: ${interactions.length}`);
    console.log('  By source:');
    for (const [src, n] of Object.entries(interactionsBySource)) {
        console.log(`    ${src}: ${n}`);
    }

    const earliest = interactions.find(i => i.timestamp);
    const latest = [...interactions].reverse().find(i => i.timestamp);
    if (earliest) console.log(`\nEarliest: ${earliest.timestamp}`);
    if (latest)   console.log(`Latest:   ${latest.timestamp}`);
}

// --- CLI ---

const [,, command, ...args] = process.argv;
switch (command) {
    case 'search':   search(args.join(' ')); break;
    case 'contact':  showContact(args[0]); break;
    case 'timeline': showTimeline(args[0]); break;
    case 'stats':    showStats(); break;
    default:
        console.log('Usage:');
        console.log('  node crm/query.js search <name|phone|email>');
        console.log('  node crm/query.js contact <id>');
        console.log('  node crm/query.js timeline <id>');
        console.log('  node crm/query.js stats');
}
