#!/usr/bin/env node
/**
 * scripts/seed-dev-data.js — generate realistic synthetic source files
 *
 * Populates data/{whatsapp,linkedin,telegram,email,sms,google-contacts}/ with
 * synthetic JSON that each loader in crm/merge.js can consume, then runs merge
 * and writes a few extras (insights.json, goals.json, sync-state.json).
 *
 * The output lets a developer boot `npm run crm` with a rich, realistic dataset
 * covering all sources, without importing any real user data.
 *
 * Deterministic: uses a seeded PRNG so every run produces the same contacts,
 * which makes smoke-test expectations stable.
 *
 * Usage:
 *   node scripts/seed-dev-data.js               # writes to ./data
 *   node scripts/seed-dev-data.js --clean       # wipe data/ first
 *   CRM_DATA_DIR=/tmp/minty-dev node scripts/seed-dev-data.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.CRM_DATA_DIR || path.join(ROOT, 'data');

// --- Deterministic PRNG (mulberry32) ---
function prng(seed) {
    let t = seed >>> 0;
    return function () {
        t = (t + 0x6D2B79F5) | 0;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}
// Module-level PRNG. `reseed(seed)` is exported so tests/callers can reset the
// stream to a known starting state and get deterministic output across calls.
let rand = prng(20260423);
function reseed(seed = 20260423) { rand = prng(seed); }
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => Math.floor(rand() * (b - a + 1)) + a;

// --- Persona catalog ---
// 40 realistic contacts spanning goal-relevant personas.
const FIRST = ['Alex', 'Priya', 'James', 'Sarah', 'Marcus', 'Aisha', 'David', 'Emma',
    'Ravi', 'Claire', 'Jordan', 'Lin', 'Noah', 'Tomás', 'Yara', 'Sam',
    'Nadia', 'Ethan', 'Maya', 'Oscar', 'Zara', 'Julian', 'Isabel', 'Hiro',
    'Fatima', 'Leo', 'Amina', 'Dev', 'Ines', 'Kai', 'Mira', 'Theo',
    'Sofia', 'Gabriel', 'Hana', 'Carlos', 'Iris', 'Omar', 'Elena', 'Tariq'];
const LAST = ['Chen', 'Patel', 'Morgan', 'Okafor', 'Lindqvist', 'Haddad', 'Sato',
    'García', 'Fernandes', 'Reyes', 'Nguyen', 'O\'Neill', 'Ivanov',
    'Kim', 'Silva', 'Ahmed', 'Rossi', 'Müller', 'Tanaka', 'Dubois',
    'Johansson', 'Mendes', 'Park', 'Abebe', 'Novak', 'Costa', 'Singh',
    'Friedman', 'Osei', 'Al-Fulan'];
const COMPANIES = [
    ['Index Ventures', 'Partner', 'Venture Capital', 'London'],
    ['Sequoia Capital', 'Principal', 'Venture Capital', 'San Francisco'],
    ['a16z', 'Partner', 'Venture Capital', 'Menlo Park'],
    ['Accel', 'Associate', 'Venture Capital', 'San Francisco'],
    ['Stripe', 'Engineering Manager', 'Fintech', 'San Francisco'],
    ['Stripe', 'Product Lead, Payments', 'Fintech', 'Dublin'],
    ['Monzo', 'Senior Engineer', 'Fintech', 'London'],
    ['Revolut', 'Staff Engineer', 'Fintech', 'London'],
    ['Google DeepMind', 'Research Scientist', 'AI', 'London'],
    ['OpenAI', 'Member of Technical Staff', 'AI', 'San Francisco'],
    ['Anthropic', 'Research Engineer', 'AI', 'San Francisco'],
    ['Nvidia', 'Senior GPU Engineer', 'Hardware', 'Santa Clara'],
    ['Meta', 'ML Engineer', 'Big Tech', 'Menlo Park'],
    ['Amazon', 'Principal Engineer', 'Big Tech', 'Seattle'],
    ['Google', 'Staff Software Engineer', 'Big Tech', 'Mountain View'],
    ['Apple', 'Senior Manager, ML Platforms', 'Big Tech', 'Cupertino'],
    ['Microsoft', 'Principal PM', 'Big Tech', 'Redmond'],
    ['Linear', 'Founding Engineer', 'SaaS', 'Remote'],
    ['Notion', 'Growth Lead', 'SaaS', 'San Francisco'],
    ['Figma', 'Design Lead', 'SaaS', 'San Francisco'],
    ['Airbnb', 'Senior PM', 'Marketplace', 'San Francisco'],
    ['Uber', 'Head of BD, EMEA', 'Mobility', 'London'],
    ['OpenDoor', 'Staff Engineer', 'PropTech', 'San Francisco'],
    ['McKinsey & Co', 'Engagement Manager', 'Consulting', 'London'],
    ['BCG', 'Principal', 'Consulting', 'New York'],
    ['Hooli', 'Co-founder & CEO', 'Startup', 'Palo Alto'],
    ['Pied Piper', 'Founder', 'Startup', 'Palo Alto'],
    ['Stealth AI startup', 'Co-founder', 'Startup', 'San Francisco'],
    ['The Trade Desk', 'Software Engineer', 'AdTech', 'Boulder'],
    ['Databricks', 'Staff Engineer', 'Data', 'San Francisco'],
    ['Snowflake', 'Solutions Architect', 'Data', 'New York'],
    ['Palantir', 'Forward Deployed Engineer', 'Enterprise', 'Denver'],
    ['Goldman Sachs', 'Vice President, TMT', 'Finance', 'New York'],
    ['JP Morgan', 'VP, Strategic Investments', 'Finance', 'London'],
    ['LinkedIn', 'Senior Product Designer', 'Big Tech', 'Sunnyvale'],
    ['Hugging Face', 'Research Engineer', 'AI', 'New York'],
    ['Scale AI', 'Engineering Manager', 'AI', 'San Francisco'],
    ['Vercel', 'DX Engineer', 'DevTools', 'Remote'],
    ['Supabase', 'Co-founder', 'DevTools', 'Singapore'],
    ['MIT', 'Professor, CSAIL', 'Academia', 'Cambridge'],
];
const TOPICS = {
    investor:  ['the round', 'your deck', 'portfolio intro', 'warm intro to the partner meeting', 'last year\'s conf', 'Series A norms'],
    founder:   ['your launch', 'pre-seed deck', 'hiring plan', 'the pivot', 'cap table', 'first 10 customers'],
    engineer:  ['that gnarly bug', 'the migration', 'cache invalidation', 'the on-call rotation', 'eBPF talk', 'Rust vs Go'],
    operator:  ['quarterly planning', 'board prep', 'the re-org', 'opex review', 'exec coaching', 'compensation bands'],
    academic:  ['the paper', 'the review cycle', 'ICLR deadline', 'funding proposal', 'PhD students'],
    creative:  ['the brand refresh', 'design critique', 'the system rework', 'Figma library', 'landing page'],
    finance:   ['term sheet', 'model assumptions', 'the LP update', 'secondary sale', 'recap'],
    consultant:['the engagement', 'the deliverable', 'rollout plan', 'offsite prep'],
    sales:     ['the pipeline', 'Q3 forecast', 'pricing push', 'enterprise deal', 'onboarding friction'],
    legal:     ['the SAFE', 'IP assignment', 'the MSA', 'side letter', 'non-compete'],
    hr:        ['sourcing plan', 'offer negotiation', 'the IC ladder', 'onboarding flow'],
};

function roleCategory(title = '') {
    const t = title.toLowerCase();
    if (/partner|associate|principal|venture|angel|investor/.test(t)) return 'investor';
    if (/founder|ceo|cto|chief executive/.test(t)) return 'founder';
    if (/engineer|developer|swe|staff|senior.*(engineer|developer)/.test(t)) return 'engineer';
    if (/coo|cfo|vp|director|head of|manager/.test(t)) return 'operator';
    if (/professor|research|academic|phd/.test(t)) return 'academic';
    if (/design|ux|brand|creative/.test(t)) return 'creative';
    if (/banker|analyst|invest.*(bank|finance)/.test(t)) return 'finance';
    if (/consult|strategy|mckinsey|bcg/.test(t)) return 'consultant';
    if (/sales|bd|business development|growth|revenue/.test(t)) return 'sales';
    if (/lawyer|counsel|legal/.test(t)) return 'legal';
    if (/recruit|talent|hr|people/.test(t)) return 'hr';
    return 'operator';
}

// --- Contact generator ---
function generateContacts(N = 40, seed = 20260423) {
    reseed(seed);
    const contacts = [];
    const names = new Set();
    for (let i = 0; i < N; i++) {
        let full;
        do {
            full = pick(FIRST) + ' ' + pick(LAST);
        } while (names.has(full));
        names.add(full);

        const [company, title, industry, location] = COMPANIES[i % COMPANIES.length];
        const category = roleCategory(title);
        const slug = full.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
        const digits = '+1' + String(2000000000 + between(0, 999999999));

        // Coverage: make sure each source has at least 8 contacts; some have multiple
        const coverage = {
            whatsapp: rand() < 0.6,
            linkedin: rand() < 0.75,
            telegram: rand() < 0.25,
            email:    rand() < 0.85,
            sms:      rand() < 0.35,
            gc:       rand() < 0.4,
        };
        // Guarantee at least one source
        if (!Object.values(coverage).some(Boolean)) coverage.linkedin = true;

        contacts.push({
            idx: i,
            fullName: full,
            slug,
            phone: digits,
            email: slug.replace(/-/g, '.') + '@' + company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com',
            company, title, industry, location, category, coverage,
        });
    }
    return contacts;
}

// --- ISO timestamps spread over last 18 months, weighted to recent ---
function randomTimestamp(weightRecent = 0.5) {
    const now = Date.now();
    const daySpan = 540;
    const bias = Math.pow(rand(), 1 + weightRecent * 2); // closer to 0 = more recent
    const daysAgo = bias * daySpan;
    return new Date(now - daysAgo * 86400000).toISOString();
}

// --- Source file builders ---

function buildWhatsApp(contacts, outDir) {
    const contactsMap = {};
    const chats = {};
    for (const c of contacts) {
        if (!c.coverage.whatsapp) continue;
        const id = c.phone.replace('+', '') + '@c.us';
        contactsMap[id] = {
            id,
            name: c.fullName,
            number: c.phone.replace('+', ''),
            isMyContact: true,
            isBusiness: false,
            about: '',
        };
        const msgCount = between(1, 40);
        const chatName = c.fullName;
        const messages = [];
        for (let i = 0; i < msgCount; i++) {
            const fromMe = rand() < 0.45;
            messages.push({
                id: `${id}_${i}_${Date.now() + i}`,
                timestamp: randomTimestamp(0.7),
                from: fromMe ? 'me' : id,
                to: fromMe ? id : 'me',
                body: pickMessage(c.category),
                type: 'chat',
                hasMedia: rand() < 0.05,
            });
        }
        messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        chats[chatName] = {
            meta: { id, name: chatName, isGroup: false },
            messages,
        };
    }
    // Add a couple of synthetic group chats. Mirrors the real WhatsApp export
    // shape: participants are plain strings, group messages have from=<chatId>
    // and author=<sender id>. We also sprinkle a few @lid participants since
    // real exports have ~50% @lid coverage.
    const allWa = contacts.filter(c => c.coverage.whatsapp);
    for (const gname of ['Founders Dinner Club', 'SF AI crew']) {
        if (allWa.length < 3) break;
        const id = `${Math.floor(rand() * 1e12)}@g.us`;
        const pickParticipants = shuffle(allWa).slice(0, Math.min(8, allWa.length));
        // 1-2 @lid anonymous lurkers — represent unsaved group members
        const anonLids = Array.from({ length: between(1, 2) }, () =>
            `${Math.floor(rand() * 1e15)}@lid`);
        chats[gname] = {
            meta: {
                id, name: gname, isGroup: true,
                participants: [
                    ...pickParticipants.map(c => c.phone.replace('+', '') + '@c.us'),
                    ...anonLids,
                ],
                createdAt: randomTimestamp(0.2),
            },
            messages: Array.from({ length: between(6, 20) }, (_v, i) => {
                // Most messages from named members; ~30% from an anon lid
                const useAnon = rand() < 0.3 && anonLids.length > 0;
                const authorId = useAnon
                    ? pick(anonLids)
                    : pick(pickParticipants).phone.replace('+', '') + '@c.us';
                return {
                    id: `${id}_${i}`,
                    timestamp: randomTimestamp(0.8),
                    from: id,                          // group id (mirrors real shape)
                    author: authorId,                  // actual sender
                    body: pickMessage(useAnon ? 'operator' : pickParticipants[0].category),
                    type: 'chat',
                };
            }),
        };
        contactsMap[id] = { id, name: gname, number: null, isMyContact: false, isBusiness: false };
    }

    writeJson(path.join(outDir, 'whatsapp/contacts.json'), contactsMap);
    writeJson(path.join(outDir, 'whatsapp/chats.json'), chats);
    writeJson(path.join(outDir, 'whatsapp/metadata.json'), { exportedAt: new Date().toISOString() });
}

function buildLinkedIn(contacts, outDir) {
    const li = contacts.filter(c => c.coverage.linkedin).map(c => ({
        name: c.fullName,
        firstName: c.fullName.split(' ')[0],
        lastName: c.fullName.split(' ').slice(1).join(' '),
        email: rand() < 0.35 ? c.email : null,
        company: c.company,
        position: c.title,
        profileUrl: `https://www.linkedin.com/in/${c.slug}`,
        connectedOn: randomTimestamp(0.1),
    }));
    writeJson(path.join(outDir, 'linkedin/contacts.json'), li);

    // Threaded messages
    const convs = contacts.filter(c => c.coverage.linkedin && rand() < 0.55).map(c => ({
        id: 'li_' + c.slug,
        participants: [c.fullName, 'Me'],
        messages: Array.from({ length: between(2, 10) }, (_, i) => {
            const fromMe = i % 2 === 1;
            return {
                timestamp: randomTimestamp(0.5),
                from: fromMe ? 'Me' : c.fullName,
                to: fromMe ? c.fullName : 'Me',
                subject: i === 0 ? pickSubject(c.category) : null,
                body: pickMessage(c.category),
                folder: 'inbox',
                hasAttachment: false,
            };
        }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
    }));
    writeJson(path.join(outDir, 'linkedin/messages.json'), convs);
    writeJson(path.join(outDir, 'linkedin/invitations.json'), { pending: [] });
}

function buildTelegram(contacts, outDir) {
    const tg = contacts.filter(c => c.coverage.telegram).map((c, i) => ({
        id: 1000000 + i,
        name: c.fullName,
        firstName: c.fullName.split(' ')[0],
        lastName: c.fullName.split(' ').slice(1).join(' '),
        phone: c.phone,
        username: c.slug.replace(/-/g, ''),
    }));
    writeJson(path.join(outDir, 'telegram/contacts.json'), tg);
    const chats = tg.map((t) => ({
        id: t.id,
        name: t.name,
        messages: Array.from({ length: between(2, 15) }, (_v, j) => {
            const fromMe = rand() < 0.5;
            return {
                id: t.id * 1000 + j,
                timestamp: randomTimestamp(0.5),
                from: fromMe ? 'me' : t.name,
                fromId: fromMe ? null : t.id,
                body: pickMessage(contacts.find(cc => cc.fullName === t.name).category),
                type: 'message',
            };
        }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
    }));
    writeJson(path.join(outDir, 'telegram/chats.json'), chats);
}

function buildEmail(contacts, outDir) {
    const em = contacts.filter(c => c.coverage.email).map(c => ({
        name: c.fullName,
        email: c.email,
        source: 'gmail',
        firstSeen: randomTimestamp(0.1),
    }));
    writeJson(path.join(outDir, 'email/contacts.json'), em);

    const msgs = [];
    for (const c of contacts.filter(cc => cc.coverage.email)) {
        const n = between(1, 12);
        for (let i = 0; i < n; i++) {
            const fromMe = rand() < 0.5;
            msgs.push({
                id: `msg_${c.slug}_${i}`,
                messageId: `<msg_${c.slug}_${i}@example.com>`,
                timestamp: randomTimestamp(0.5),
                from: fromMe ? 'me@example.com' : c.email,
                to: fromMe ? [c.email] : ['me@example.com'],
                cc: [],
                subject: pickSubject(c.category),
                body: pickMessage(c.category),
            });
        }
    }
    msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    writeJson(path.join(outDir, 'email/messages.json'), msgs);
    writeJson(path.join(outDir, 'email/gmail-state.json'), { historyId: '1', lastSyncAt: new Date().toISOString() });
}

function buildSms(contacts, outDir) {
    const sms = contacts.filter(c => c.coverage.sms).map(c => ({
        name: c.fullName,
        phone: c.phone,
        messageCount: between(2, 35),
        lastMessageAt: randomTimestamp(0.7),
    }));
    writeJson(path.join(outDir, 'sms/contacts.json'), sms);
    const threads = sms.map(s => {
        const c = contacts.find(cc => cc.phone === s.phone);
        return {
            phone: s.phone,
            contactName: s.name,
            messages: Array.from({ length: s.messageCount }, () => ({
                body: pickMessage(c.category),
                timestamp: randomTimestamp(0.8),
                direction: rand() < 0.5 ? 'sent' : 'received',
                read: true,
                hasMedia: false,
            })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
        };
    });
    writeJson(path.join(outDir, 'sms/messages.json'), threads);
}

function buildGoogleContacts(contacts, outDir) {
    const gc = contacts.filter(c => c.coverage.gc).map(c => ({
        name: c.fullName,
        phones: [c.phone],
        emails: c.coverage.email ? [c.email] : [],
        org: c.company,
        title: c.title,
        note: rand() < 0.2 ? `Met at ${pick(['YC AI Pre-seed dinner', 'the Stripe meetup', 'a16z demo day', 'SF founders brunch'])}` : null,
    }));
    writeJson(path.join(outDir, 'google-contacts/contacts.json'), gc);
    writeJson(path.join(outDir, 'google-contacts/gc-state.json'), { syncToken: 'fake-token', lastSyncAt: new Date().toISOString() });
}

// --- Supporting helpers ---
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function pickSubject(cat) {
    const subjects = {
        investor:  ['Re: intro to the partner meeting', 'Quick follow-up on the deck', 'Round update'],
        founder:   ['Checking in post-demo', 'Pre-seed update', 'Intro request'],
        engineer:  ['Re: that bug we talked about', 'Migration plan', 'Eng catchup'],
        operator:  ['Quarterly planning', 'Board prep', 'Intro request'],
        academic:  ['Re: paper draft', 'Workshop invite'],
        creative:  ['Brand refresh — thoughts?', 'Figma library'],
        finance:   ['Term sheet redline', 'Model v3'],
        consultant:['Engagement update', 'Workshop prep'],
        sales:     ['Pipeline review', 'Q3 forecast'],
        legal:     ['Redline — SAFE', 'IP assignment check'],
        hr:        ['Candidate pipeline', 'Offer discussion'],
    };
    return pick(subjects[cat] || subjects.operator);
}

const FILLER = [
    'great chatting earlier', 'let\'s grab coffee next week', 'thanks for the intro',
    'I\'ll have a look and circle back', 'sending over the doc shortly',
    'does Thursday 3pm work?', 'good talking', 'really appreciated your time',
    'your side of things?', 'saw the post — well done',
    'congrats on the news!', 'I owe you one',
    'let me think on it', 'ping me if anything changes',
];

// Occasional announcement-style messages so life-event detection has something
// meaningful to pick up during offline smoke-tests.
const ANNOUNCEMENTS = {
    investor:   ['I just closed my Series A at Index', 'Excited to announce I\'m joining a16z as a Partner'],
    founder:    ['We raised a $4M seed round led by Accel!', 'I\'m excited to announce I\'m joining Linear as co-founder', 'We just launched on Product Hunt today'],
    engineer:   ['Excited to announce I\'m joining Stripe next month', 'Just started at Anthropic as a research engineer'],
    operator:   ['Got promoted to VP of Product', 'Excited to announce I\'m moving to Airbnb'],
    creative:   ['Just launched — live on Product Hunt', 'Starting at Figma as Design Lead'],
    finance:    ['Starting a new role at Goldman Sachs', 'Got promoted to Vice President'],
    consultant: ['Just made Principal at BCG', 'Excited to announce I\'m joining McKinsey'],
    sales:      ['Closed our biggest deal yet — $2M ARR', 'Got promoted to Head of Sales'],
    academic:   ['Paper got accepted to NeurIPS', 'Starting a postdoc at MIT'],
    legal:      ['Made partner at the firm', 'Excited to announce I\'m joining a new firm'],
    hr:         ['Got promoted to Head of People', 'Starting at Stripe as Head of Talent'],
};

function pickMessage(cat) {
    const topic = pick(TOPICS[cat] || TOPICS.operator);
    const filler = pick(FILLER);
    // ~5% of messages are announcements so life-event detection has seed signal
    if (rand() < 0.05) {
        const bag = ANNOUNCEMENTS[cat] || ANNOUNCEMENTS.operator;
        return pick(bag);
    }
    if (rand() < 0.25) return filler + '.';
    if (rand() < 0.5) return `${filler} about ${topic}.`;
    if (rand() < 0.75) return `Quick note on ${topic} — ${filler}.`;
    return `Following up on ${topic}. ${filler.charAt(0).toUpperCase() + filler.slice(1)}?`;
}

function writeJson(p, data) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// --- Extras: insights, goals, sync-state ---
function buildExtras(contacts, outDir) {
    const unifiedPath = path.join(outDir, 'unified');
    if (!fs.existsSync(unifiedPath)) return;
    const unifiedContacts = JSON.parse(fs.readFileSync(path.join(unifiedPath, 'contacts.json'), 'utf8'));

    const insights = {};
    for (const c of unifiedContacts) {
        if (c.isGroup) continue;
        if (!c.name) continue; // skip anonymous @lid lurkers — no name to draft against
        if (rand() > 0.7) continue;
        const src = contacts.find(sc => sc.fullName === c.name);
        const category = src ? src.category : 'operator';
        const firstName = c.name.split(/\s+/)[0] || 'there';
        insights[c.id] = {
            topics: shuffle(TOPICS[category] || TOPICS.operator).slice(0, 3),
            openLoops: rand() < 0.35 ? [`Follow up on ${pick(TOPICS[category] || TOPICS.operator)}`] : [],
            sentiment: pick(['positive', 'warm', 'neutral']),
            meetingBrief: c.name + ' — ' + (src && src.title ? src.title + ' at ' + src.company : 'contact') +
                '. Most recent chats have been about ' + pick(TOPICS[category] || TOPICS.operator) + '.',
            keywords: shuffle(['plan', 'team', 'hire', 'round', 'deal', 'ship', 'design', 'data']).slice(0, 5),
            reconnectDraft: `Hey ${firstName}, been a minute — last we caught up it was about ${pick(TOPICS[category] || TOPICS.operator)}. Quick question for you: [your ask]. Up for a call this week?`,
            analyzedAt: new Date().toISOString(),
        };
    }
    writeJson(path.join(unifiedPath, 'insights.json'), insights);

    writeJson(path.join(unifiedPath, 'goals.json'), [
        { id: 'g_1', text: 'Raise a seed round of $2-4M for our stealth AI devtools startup', createdAt: new Date().toISOString() },
        { id: 'g_2', text: 'Hire senior engineer #1 — Rust/systems background', createdAt: new Date().toISOString() },
        { id: 'g_3', text: 'Warm intro to product leaders at Stripe and Linear', createdAt: new Date().toISOString() },
    ]);

    writeJson(path.join(DATA, 'sync-state.json'), {
        whatsapp:       { lastSyncAt: new Date().toISOString(), status: 'ok', messageCount: unifiedContacts.length * 5 },
        email:          { lastSyncAt: new Date().toISOString(), historyId: '1', status: 'ok' },
        googleContacts: { lastSyncAt: new Date().toISOString(), syncToken: 'fake', status: 'ok' },
        linkedin:       { lastSyncAt: new Date().toISOString(), fileHash: 'seeded', status: 'ok' },
        telegram:       { lastSyncAt: new Date().toISOString(), fileHash: 'seeded', status: 'ok' },
        sms:            { lastSyncAt: new Date().toISOString(), fileHash: 'seeded', status: 'ok' },
        calendar:       { lastSyncAt: null, status: 'idle', upcomingMeetings: [] },
    });
}

// --- Main ---
function main() {
    const args = process.argv.slice(2);
    const clean = args.includes('--clean');

    if (clean && fs.existsSync(DATA)) {
        console.log(`Cleaning ${DATA}...`);
        fs.rmSync(DATA, { recursive: true, force: true });
    }

    const contacts = generateContacts(40);
    fs.mkdirSync(DATA, { recursive: true });

    console.log(`Seeding synthetic sources into ${DATA}...`);
    buildWhatsApp(contacts, DATA);
    buildLinkedIn(contacts, DATA);
    buildTelegram(contacts, DATA);
    buildEmail(contacts, DATA);
    buildSms(contacts, DATA);
    buildGoogleContacts(contacts, DATA);

    console.log('Running merge...');
    execFileSync('node', [path.join(ROOT, 'crm/merge.js')], {
        cwd: ROOT,
        env: { ...process.env, CRM_DATA_DIR: DATA, CRM_OUT_DIR: path.join(DATA, 'unified') },
        stdio: 'inherit',
    });

    buildExtras(contacts, DATA);
    console.log('\n✓ Dev data seeded. Boot with `npm run crm` to see the UI.');
}

if (require.main === module) main();

module.exports = {
    generateContacts,
    buildWhatsApp,
    buildLinkedIn,
    buildTelegram,
    buildEmail,
    buildSms,
    buildGoogleContacts,
    buildExtras,
    prng,
    reseed,
};
