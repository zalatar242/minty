/**
 * Contact insight generator.
 *
 * This script is designed to be run by Claude Code (the AI agent), NOT at
 * server runtime. The agent reads interaction history and writes synthesized
 * insights to data/unified/insights.json.
 *
 * Usage: node crm/analyze.js
 *
 * The script computes what it can algorithmically (keyword frequency, source
 * breakdown, recency). For narrative synthesis (meetingBrief, topics,
 * openLoops), run this script to generate the scaffold, then ask Claude Code
 * to read the interaction data and fill in the synthesized insights.
 *
 * Insight schema per contact:
 * {
 *   topics:      string[]   // top recurring subjects in conversations
 *   openLoops:   string[]   // things mentioned that were never followed up
 *   sentiment:   string     // "warm" | "neutral" | "cooling" | "cold"
 *   meetingBrief: string    // 2-3 sentence relationship context
 *   sourceSplit: object     // { whatsapp: N, linkedin: N, ... }
 *   analyzedAt:  string     // ISO timestamp
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { buildReconnectTemplate } = require('./reconnect');

const DATA = path.join(__dirname, '../data');
const CONTACTS_PATH = path.join(DATA, 'unified/contacts.json');
const INTERACTIONS_PATH = path.join(DATA, 'unified/interactions.json');
const INSIGHTS_PATH = path.join(DATA, 'unified/insights.json');

function load(p) {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildIndex(interactions) {
    const idx = { byChatId: {}, byFrom: {}, byLiName: {}, byEmail: {} };
    for (const i of interactions) {
        if (i.chatId) {
            if (!idx.byChatId[i.chatId]) idx.byChatId[i.chatId] = [];
            idx.byChatId[i.chatId].push(i);
        }
        if (i.from && i.from !== 'me') {
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

function getContactInteractions(contact, idx) {
    const seen = new Set();
    const results = [];
    function add(list) {
        for (const i of (list || [])) {
            const key = i.id || `${i.source}:${i.timestamp}:${String(i.body || '').slice(0, 20)}`;
            if (!seen.has(key)) { seen.add(key); results.push(i); }
        }
    }
    if (contact.sources.whatsapp) {
        add(idx.byChatId[contact.sources.whatsapp.id]);
        add(idx.byFrom[contact.sources.whatsapp.id]);
    }
    if (contact.sources.linkedin && contact.sources.linkedin.name) {
        add(idx.byLiName[contact.sources.linkedin.name]);
    }
    for (const email of contact.emails) { add(idx.byEmail[email]); }
    if (contact.sources.sms) { add(idx.byChatId[contact.sources.sms.phone]); }
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return results;
}

function computeSourceSplit(interactions) {
    const split = {};
    for (const i of interactions) {
        split[i.source] = (split[i.source] || 0) + 1;
    }
    return split;
}

// Naive keyword extraction: strip stop words, count remaining
const STOP = new Set('i me my we our you your he she it its they them the a an and or but is are was were be been have has had do does did will would could should may might shall can of in on at to for with from by about like into through during including until against among throughout after before above below between out off over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very just because while although since if though unless whereas'.split(' '));

function extractKeywords(interactions, topN = 10) {
    const freq = {};
    for (const i of interactions) {
        const words = String(i.body || i.subject || '').toLowerCase()
            .replace(/[^a-z\s]/g, ' ').split(/\s+/)
            .filter(w => w.length > 3 && !STOP.has(w));
        for (const w of words) freq[w] = (freq[w] || 0) + 1;
    }
    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([w]) => w);
}

function run() {
    const contacts = load(CONTACTS_PATH);
    const interactions = load(INTERACTIONS_PATH);
    if (!contacts || !interactions) {
        console.error('Missing contacts or interactions data. Run merge.js first.');
        process.exit(1);
    }

    const idx = buildIndex(interactions);
    const existing = load(INSIGHTS_PATH) || {};

    // Analyze contacts that have interactions (top scored + reconnect candidates)
    const toAnalyze = contacts
        .filter(c => c.name && (c.interactionCount || 0) > 0)
        .sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0));

    let generated = 0;
    let draftsAdded = 0;
    for (const contact of toAnalyze) {
        // For fully-analyzed contacts missing a reconnectDraft: add algorithmic draft
        if (existing[contact.id] && existing[contact.id].analyzedAt) {
            if (!existing[contact.id].reconnectDraft && (contact.interactionCount || 0) >= 3) {
                const msgs = getContactInteractions(contact, idx);
                if (msgs.length >= 3) {
                    const recentSnippets = msgs.slice(0, 3)
                        .map(m => (m.body || m.subject || '').slice(0, 80))
                        .filter(Boolean);
                    existing[contact.id].reconnectDraft = buildReconnectTemplate(
                        contact, existing[contact.id], recentSnippets
                    );
                    draftsAdded++;
                }
            }
            continue; // skip full re-analysis
        }

        const msgs = getContactInteractions(contact, idx);
        if (msgs.length === 0) continue;

        const sourceSplit = computeSourceSplit(msgs);
        const keywords = extractKeywords(msgs);

        // Sentiment heuristic: based on recency
        const days = contact.daysSinceContact;
        const sentiment = days === null ? 'cold'
            : days < 30  ? 'warm'
            : days < 90  ? 'neutral'
            : days < 365 ? 'cooling'
            : 'cold';

        const scaffold = {
            topics: [],        // to be filled by Claude Code agent
            openLoops: [],     // to be filled by Claude Code agent
            sentiment,
            meetingBrief: '', // to be filled by Claude Code agent
            keywords,          // raw keyword frequencies for reference
            sourceSplit,
            messageCount: msgs.length,
            analyzedAt: null,  // set when agent fills in the narrative fields
        };

        // Generate an algorithmic reconnect draft (can be overwritten by Claude Code agent)
        if (msgs.length >= 3) {
            const recentSnippets = msgs.slice(0, 3)
                .map(m => (m.body || m.subject || '').slice(0, 80))
                .filter(Boolean);
            scaffold.reconnectDraft = buildReconnectTemplate(contact, null, recentSnippets);
        }

        existing[contact.id] = scaffold;
        generated++;
    }

    fs.writeFileSync(INSIGHTS_PATH, JSON.stringify(existing, null, 2));
    console.log(`Insights scaffold generated for ${generated} new contacts → data/unified/insights.json`);
    if (draftsAdded > 0) console.log(`Algorithmic reconnect draft added to ${draftsAdded} already-analyzed contacts.`);
    console.log(`Total contacts with insight records: ${Object.keys(existing).length}`);
    const withDraft = Object.values(existing).filter(v => v.reconnectDraft).length;
    console.log(`Contacts with reconnect draft: ${withDraft}`);
    console.log('\nNext step: Run Claude Code and ask it to fill in topics, openLoops, meetingBrief, and reconnectDraft');
    console.log('by reading the interaction data for contacts where analyzedAt is null.');
}

run();
