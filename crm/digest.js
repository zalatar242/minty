/**
 * Weekly digest generator.
 *
 * Designed to be run by Claude Code (the AI agent), NOT at server runtime.
 * The agent reads contacts + interactions + insights, then:
 *   1. This script computes all algorithmic fields automatically.
 *   2. Claude Code fills in the narrative weekSummary by reading the data.
 *
 * Usage: node crm/digest.js
 *
 * Output: data/unified/digest.json
 * {
 *   generatedAt:   string       // ISO timestamp
 *   weekSummary:   string       // narrative overview (Claude Code fills this in)
 *   topReconnects: Contact[]    // dormant VIPs (score>=50, >60d)
 *   openLoops:     {contact, loop, contactId}[]  // from insights.json
 *   activeThisWeek: Contact[]   // contacted in last 7 days
 *   strongRelationships: Contact[] // score>=70, recently contacted
 *   networkStats:  object       // total, strong, atRisk, dormant counts
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { buildWarmIntroBriefs } = require('./people-graph');

const DATA = path.join(__dirname, '../data');
const CONTACTS_PATH     = path.join(DATA, 'unified/contacts.json');
const INTERACTIONS_PATH = path.join(DATA, 'unified/interactions.json');
const INSIGHTS_PATH     = path.join(DATA, 'unified/insights.json');
const MEMBERSHIPS_PATH  = path.join(DATA, 'unified/group-memberships.json');
const DIGEST_PATH       = path.join(DATA, 'unified/digest.json');

function load(p) {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function contactSummary(c) {
    return {
        id: c.id,
        name: c.name,
        position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
        company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
        relationshipScore: c.relationshipScore || 0,
        daysSinceContact: c.daysSinceContact ?? null,
        activeChannels: c.activeChannels || [],
        lastContactedAt: c.lastContactedAt || null,
    };
}

function run() {
    const contacts = load(CONTACTS_PATH);
    if (!contacts) { console.error('contacts.json not found — run merge first'); process.exit(1); }

    const insights = load(INSIGHTS_PATH) || {};

    // Filter out groups and unnamed
    const people = contacts.filter(c => !c.isGroup && c.name);

    // --- Algorithmic fields ---

    const now = Date.now();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

    const activeThisWeek = people
        .filter(c => c.lastContactedAt && (now - new Date(c.lastContactedAt)) < oneWeekMs)
        .sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0))
        .slice(0, 10)
        .map(contactSummary);

    const topReconnects = people
        .filter(c => (c.relationshipScore || 0) >= 50 && (c.daysSinceContact ?? 999) >= 60)
        .sort((a, b) =>
            (b.relationshipScore || 0) * (b.daysSinceContact || 0) -
            (a.relationshipScore || 0) * (a.daysSinceContact || 0))
        .slice(0, 8)
        .map(contactSummary);

    const strongRelationships = people
        .filter(c => (c.relationshipScore || 0) >= 70)
        .sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0))
        .slice(0, 10)
        .map(contactSummary);

    // Open loops from insights
    const openLoops = [];
    for (const [contactId, ins] of Object.entries(insights)) {
        if (!ins.openLoops || !ins.openLoops.length) continue;
        const contact = people.find(c => c.id === contactId);
        if (!contact) continue;
        for (const loop of ins.openLoops) {
            openLoops.push({
                contactId,
                contactName: contact.name,
                loop,
                relationshipScore: contact.relationshipScore || 0,
            });
        }
    }
    openLoops.sort((a, b) => b.relationshipScore - a.relationshipScore);

    const networkStats = {
        total: people.length,
        strong:  people.filter(c => (c.relationshipScore || 0) >= 70).length,
        atRisk:  people.filter(c => (c.relationshipScore || 0) >= 50 && (c.daysSinceContact ?? 999) >= 60).length,
        dormant: people.filter(c => (c.relationshipScore || 0) < 20).length,
        activeThisWeek: activeThisWeek.length,
    };

    // Warm-intro briefs: for each top reconnect, compute the warmest intermediary
    // via shared WhatsApp groups. This is the "Priya gasp moment" from
    // docs/PHILOSOPHY.md — surfacing paths the user didn't know they had.
    const memberships = load(MEMBERSHIPS_PATH) || {};
    let viewerId = null;
    let bestGroupCount = 0;
    for (const c of contacts) {
        const n = Array.isArray(c.groupMemberships) ? c.groupMemberships.length : 0;
        if (n > bestGroupCount) { viewerId = c.id; bestGroupCount = n; }
    }
    const warmIntroTargets = topReconnects.map(t => ({ id: t.id, name: t.name }));
    const warmIntroBriefs = buildWarmIntroBriefs(
        warmIntroTargets,
        contacts,
        memberships,
        { excludeIds: viewerId ? [viewerId] : [], maxGroupSize: 200 }
    ).slice(0, 5);

    const digest = {
        generatedAt: new Date().toISOString(),
        weekSummary: null, // Claude Code fills this in after reading the data above
        networkStats,
        activeThisWeek,
        topReconnects,
        strongRelationships,
        openLoops: openLoops.slice(0, 15),
        warmIntroBriefs,
    };

    fs.writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2));
    console.log('Digest scaffold written to data/unified/digest.json');
    console.log(`Stats: ${networkStats.total} people | ${networkStats.activeThisWeek} active this week | ${networkStats.atRisk} at risk | ${openLoops.length} open loops`);
    console.log('\nNow ask Claude Code to fill in weekSummary by reading the digest data.');
}

run();
