/**
 * Minty — relationship intelligence server.
 * Serves a full web UI: contact list, contact detail, match review queue.
 *
 * Usage: node crm/server.js   (or: npm run crm)
 * Then open http://localhost:3456
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const {
    getSharedGroups,
    findIntroPaths,
    computeGroupSignalScores,
} = require('./people-graph');
const sourceProgress = require('../sources/_shared/progress');
const notifications = require('./notifications');
const userConfig = require('./config');
const observability = require('./observability');

observability.init();

const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 to expose on LAN
// Data directory — defaults to ./data, but the mode persisted in
// `minty-mode.json` (or env vars at boot) chooses between real and demo.
//   CRM_DATA_DIR=/abs/path  → use that exactly (highest priority)
//   MINTY_DEMO=1            → force ./data-demo
//   minty-mode.json:        → { mode: 'demo' | 'real' } persisted by the
//                              Settings UI; survives restarts.
const MODE_FILE = path.join(__dirname, '../minty-mode.json');
function readPersistedMode() {
    try { return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode || null; }
    catch { return null; }
}
function writePersistedMode(mode) {
    fs.writeFileSync(MODE_FILE, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2));
}
const PERSISTED_MODE = readPersistedMode();
const DATA = process.env.CRM_DATA_DIR
    ? path.resolve(process.env.CRM_DATA_DIR)
    : (process.env.MINTY_DEMO === '1' || PERSISTED_MODE === 'demo'
        ? path.join(__dirname, '../data-demo')
        : path.join(__dirname, '../data'));
const IS_DEMO = process.env.MINTY_DEMO === '1' || PERSISTED_MODE === 'demo'
    || /(^|\/)data-demo($|\/)/.test(DATA);

// Request body size caps (defense against memory DoS)
const JSON_BODY_MAX   = 1 * 1024 * 1024;    // 1 MB for JSON POSTs
const UPLOAD_BODY_MAX = 50 * 1024 * 1024;   // 50 MB for multipart uploads

// Bootstrap empty data files on first run.
(function ensureDataFiles() {
    const dir = path.join(DATA, 'unified');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const defaults = {
        'contacts.json': '[]',
        'interactions.json': '[]',
    };
    for (const [f, contents] of Object.entries(defaults)) {
        const p = path.join(dir, f);
        if (!fs.existsSync(p)) fs.writeFileSync(p, contents);
    }
})();

// "12025551234@c.us" -> "wa_12025551234". Strips any non-digit so the
// contact ID matches what crm/merge.js's waStableId produces from
// whatsapp/contacts.json's `c.number` field.
function widToContactId(wid) {
    if (!wid) return null;
    const digits = String(wid).replace(/@.*$/, '').replace(/[^0-9]/g, '');
    return digits ? `wa_${digits}` : null;
}

function selfIdentityPath(uuid) {
    return path.join(getUserDataDir(uuid), 'self.json');
}

// Persisted at data/<uuid>/self.json:
//   { whatsapp: { wid, pushname }, contactIds: ["wa_12025551234", ...],
//     phones: ["12025551234"], emails: [...] }
// contactIds covers WhatsApp; phones/emails are reserved for explicit
// future overrides (e.g. when the user owns multiple numbers).
function loadSelfIdentity(uuid) {
    try {
        const raw = fs.readFileSync(selfIdentityPath(uuid), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
}

function saveSelfIdentity(uuid, patch) {
    const cur = loadSelfIdentity(uuid);
    const merged = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    const ids = new Set(cur.contactIds || []);
    if (patch.whatsapp?.wid) {
        const cid = widToContactId(patch.whatsapp.wid);
        if (cid) ids.add(cid);
    }
    if (Array.isArray(patch.contactIds)) patch.contactIds.forEach(id => ids.add(id));
    merged.contactIds = [...ids];
    try {
        const p = selfIdentityPath(uuid);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = `${p}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
        fs.renameSync(tmp, p);
        try { fs.chmodSync(p, 0o600); } catch { /* ignore */ }
    } catch (e) {
        console.error('[self] save failed:', e.message);
    }
    return merged;
}

function getUserPaths(uuid) {
    const base = path.join(DATA, 'unified');
    const self = loadSelfIdentity(uuid);
    return {
        contacts:     path.join(base, 'contacts.json'),
        interactions: path.join(base, 'interactions.json'),
        overrides:    path.join(base, 'match_overrides.json'),
        insights:     path.join(base, 'insights.json'),
        digest:       path.join(base, 'digest.json'),
        goals:        path.join(base, 'goals.json'),
        queryIndex:   path.join(base, 'query-index.json'),
        selfIds:      new Set(self.contactIds || []),
    };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

// In-memory contacts cache: avoid re-reading 5MB+ file on every request.
// We cache the *raw* parsed array and apply selfIds filtering on each call,
// so a fresh self-identity capture takes effect on the next request without
// waiting for contacts.json to be re-merged.
const _contactsCache = {};
function loadContacts(paths) {
    const key = paths.contacts;
    try {
        const mtime = fs.statSync(key).mtimeMs;
        let raw;
        if (_contactsCache[key] && _contactsCache[key].mtime === mtime) {
            raw = _contactsCache[key].raw;
        } else {
            raw = JSON.parse(fs.readFileSync(key, 'utf8'));
            _contactsCache[key] = { mtime, raw };
        }
        return paths.selfIds?.size ? raw.filter(c => !paths.selfIds.has(c.id)) : raw;
    } catch {
        return [];
    }
}

function loadOverrides(paths) {
    try { return JSON.parse(fs.readFileSync(paths.overrides, 'utf8')); } catch { return []; }
}

function loadInsights(paths) {
    try { return JSON.parse(fs.readFileSync(paths.insights, 'utf8')); } catch { return {}; }
}

function saveOverrides(overrides, paths) {
    fs.writeFileSync(paths.overrides, JSON.stringify(overrides, null, 2));
}

// Lightweight summary for list view
function contactSummary(c) {
    const overrideMatch = (c.notes || '').match(/score_override:(\d+)/);
    const scoreOverride = overrideMatch ? parseInt(overrideMatch[1]) : null;
    return {
        id: c.id,
        name: c.name,
        phones: c.phones,
        emails: c.emails,
        sources: Object.keys(c.sources).filter(k => c.sources[k] !== null),
        company: c.sources.linkedin?.company || c.sources.googleContacts?.org || null,
        position: c.sources.linkedin?.position || c.sources.googleContacts?.title || null,
        location: c.apollo?.location || null,
        lastContactedAt: c.lastContactedAt,
        isBusiness: c.sources.whatsapp?.isBusiness || false,
        isGroup: c.isGroup || false,
        relationshipScore: scoreOverride ?? c.relationshipScore ?? 0,
        daysSinceContact: scoreOverride ? 0 : (c.daysSinceContact ?? null), // no decay for overridden
        activeChannels: c.activeChannels || [],
        interactionCount: c.interactionCount || 0,
    };
}

// Helper: is a contact actually a WA group chat? Works before and after re-merge.
function isGroupContact(c) {
    if (c.isGroup) return true;
    const waId = c.sources?.whatsapp?.id || '';
    return waId.endsWith('@g.us');
}

// ---------------------------------------------------------------------------
// Interaction index (built once on first request)
// ---------------------------------------------------------------------------

const _interactionIndex = {};

function getInteractionIndex(paths, uuid) {
    if (_interactionIndex[uuid]) return _interactionIndex[uuid];

    const interactions = JSON.parse(fs.readFileSync(paths.interactions, 'utf8'));
    const idx = { byChatId: {}, byFrom: {}, byEmail: {}, byLiName: {} };

    for (const i of interactions) {
        if (i.chatId) {
            if (!idx.byChatId[i.chatId]) idx.byChatId[i.chatId] = [];
            idx.byChatId[i.chatId].push(i);
        }
        if (i.from && typeof i.from === 'string') {
            if (!idx.byFrom[i.from]) idx.byFrom[i.from] = [];
            idx.byFrom[i.from].push(i);
        }
        // LinkedIn: index each participant name from chatName "A, B, C"
        if (i.source === 'linkedin' && i.chatName) {
            for (const name of i.chatName.split(',').map(n => n.trim())) {
                if (!idx.byLiName[name]) idx.byLiName[name] = [];
                idx.byLiName[name].push(i);
            }
        }
        // Email: index from/to
        if (i.source === 'email') {
            const addrs = [i.from, ...(Array.isArray(i.to) ? i.to : [i.to])].filter(Boolean);
            for (const addr of addrs) {
                if (!idx.byEmail[addr]) idx.byEmail[addr] = [];
                idx.byEmail[addr].push(i);
            }
        }
    }

    _interactionIndex[uuid] = idx;
    console.log(`Interaction index built for ${uuid} (${interactions.length} interactions)`);
    return _interactionIndex[uuid];
}

function getContactInteractions(contact, paths, uuid) {
    const idx = getInteractionIndex(paths, uuid);
    const seen = new Set();
    const results = [];

    function add(list) {
        for (const i of (list || [])) {
            const key = i.id || `${i.source}:${i.timestamp}:${i.body?.slice(0, 20)}`;
            if (!seen.has(key)) { seen.add(key); results.push(i); }
        }
    }

    // WhatsApp: direct chats (chatId = their WA id) + their messages in group chats
    if (contact.sources.whatsapp) {
        const waId = contact.sources.whatsapp.id;
        add(idx.byChatId[waId]);
        add(idx.byFrom[waId]);
    }

    // LinkedIn: any conversation they appear in
    if (contact.sources.linkedin?.name) {
        add(idx.byLiName[contact.sources.linkedin.name]);
    }

    // Email
    for (const email of contact.emails) {
        add(idx.byEmail[email]);
    }

    // SMS: chatId is the phone number
    if (contact.sources.sms) {
        const phone = contact.sources.sms.phone;
        add(idx.byChatId[phone]);
    }

    results.sort((a, b) => {
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return new Date(b.timestamp) - new Date(a.timestamp);
    });

    return results;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function body(req, max = JSON_BODY_MAX) {
    return new Promise((resolve, reject) => {
        let s = '';
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > max) { req.destroy(); reject(new Error('payload too large')); return; }
            s += c;
        });
        req.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { reject(e); } });
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleListContacts(req, res, params, paths , ) {
    const contacts = loadContacts(paths);
    const people = contacts.filter(c => !isGroupContact(c));
    json(res, people.map(contactSummary));
}

/**
 * Identify the viewer's own contact record. In Minty's single-user mode, the
 * viewer is in every WhatsApp group by definition, so the contact with the
 * most group memberships is a reliable heuristic. Cached by contacts mtime.
 */
const _viewerIdCache = {};
function getViewerContactId(paths) {
    const key = paths.contacts;
    try {
        const mtime = fs.statSync(key).mtimeMs;
        if (_viewerIdCache[key] && _viewerIdCache[key].mtime === mtime) {
            return _viewerIdCache[key].id;
        }
        const contacts = loadContacts(paths);
        let best = null, bestCount = 0;
        for (const c of contacts) {
            const n = Array.isArray(c.groupMemberships) ? c.groupMemberships.length : 0;
            if (n > bestCount) { best = c.id; bestCount = n; }
        }
        _viewerIdCache[key] = { mtime, id: best };
        return best;
    } catch { return null; }
}

function handleGetContact(req, res, [id], paths, uuid) {
    const allContacts = loadContacts(paths);
    const contact = allContacts.find(c => c.id === id);
    if (!contact) return json(res, { error: 'not found' }, 404);
    // Enrich with shared-groups metadata for the "you're both in…" section.
    const memberships = loadGroupMemberships();
    const sharedGroups = getSharedGroups(contact, memberships);
    // Engagement metrics (reply rate, latency, initiation balance)
    const metrics = computeContactEngagement(contact, paths, uuid);
    // Resolved @-mentions in *this contact's* notes and the reverse index
    // (who mentions this contact in their notes).
    const mentionsOut = _mentionsModule.resolveMentions(contact.notes || '', allContacts);
    const backlinks = getMentionIndex(allContacts)[id] || [];
    json(res, {
        ...contact,
        sharedGroups,
        metrics,
        mentionsOut,
        mentionBacklinks: backlinks,
    });
}

const _mentionsModule = require('./mentions');
const _exportModule = require('./export');
const _lifeEvents = require('./life-events');
const _goalRetro = require('./goal-retro');
const _meetingDebrief = require('./meeting-debrief');

function loadDebriefs(paths) {
    try {
        const p = path.join(path.dirname(paths.contacts), 'meeting-debriefs.json');
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return {}; }
}

function saveDebriefs(paths, store) {
    const p = path.join(path.dirname(paths.contacts), 'meeting-debriefs.json');
    fs.writeFileSync(p, JSON.stringify(store, null, 2));
}

/**
 * GET /api/meetings/debriefs/pending
 * Returns past meetings that haven't yet been debriefed, for the Today card.
 */
function handleGetPendingDebriefs(req, res, _params, paths) {
    const syncStatePath = path.join(path.dirname(paths.contacts), '..', 'sync-state.json');
    let meetings = [];
    try {
        const syncState = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
        meetings = (syncState.calendar && syncState.calendar.upcomingMeetings) || [];
    } catch { meetings = []; }
    const store = loadDebriefs(paths);
    const pending = _meetingDebrief.pendingDebriefs(meetings, store);
    json(res, { count: pending.length, meetings: pending });
}

/**
 * POST /api/meetings/:id/debrief
 * Persist the user's debrief notes + stage moves for a meeting.
 */
async function handleSaveDebrief(req, res, [meetingId], paths) {
    const payload = await body(req);
    try {
        const store = loadDebriefs(paths);
        const updated = _meetingDebrief.recordDebrief(store, meetingId, payload || {});
        saveDebriefs(paths, updated);
        // Apply stage moves against goals.json if supplied
        if (payload && Array.isArray(payload.stageMoves) && payload.stageMoves.length) {
            const goals = loadGoals(paths);
            let touched = false;
            for (const mv of payload.stageMoves) {
                if (!mv || !mv.goalId || !mv.contactId || !mv.stage) continue;
                const g = goals.find(x => x.id === mv.goalId);
                if (!g) continue;
                g.assignments = g.assignments || {};
                g.assignments[mv.contactId] = { stage: mv.stage, updatedAt: new Date().toISOString() };
                touched = true;
            }
            if (touched) fs.writeFileSync(paths.goals, JSON.stringify(goals, null, 2));
        }
        json(res, { meetingId, debrief: updated[meetingId] });
    } catch (e) {
        json(res, { error: e.message }, 400);
    }
}

/**
 * GET /api/meetings/:id/debrief — read a previously-logged debrief.
 */
function handleGetDebrief(req, res, [meetingId], paths) {
    const store = loadDebriefs(paths);
    const entry = store[meetingId];
    if (!entry) return json(res, { error: 'not logged' }, 404);
    json(res, { meetingId, debrief: entry });
}

/**
 * GET /api/goals/:id/retro
 * Synthesise a goal retro — pipeline funnel, stuck/moving/ghosted/replied
 * contacts, plus a short narrative paragraph.
 */
function handleGoalRetro(req, res, [goalId], paths, uuid) {
    const goals = loadGoals(paths);
    const goal = goals.find(g => g.id === goalId);
    if (!goal) return json(res, { error: 'goal not found' }, 404);

    const contacts = loadContacts(paths);
    const ixns = fs.existsSync(paths.interactions)
        ? JSON.parse(fs.readFileSync(paths.interactions, 'utf8')) : [];
    const { contactMap } = buildSearchIndex(paths, uuid);
    const byContact = {};
    for (const i of ixns) {
        let cid = null;
        if (i.chatId) cid = contactMap[i.chatId];
        if (!cid && typeof i.from === 'string') cid = contactMap[i.from];
        if (!cid && i.source === 'linkedin' && i.chatName) {
            for (const name of i.chatName.split(',').map(n => n.trim())) {
                if (contactMap[name]) { cid = contactMap[name]; break; }
            }
        }
        if (!cid) continue;
        if (!byContact[cid]) byContact[cid] = [];
        byContact[cid].push({ ...i, _contactId: cid });
    }
    const selfIds = new Set(['me', ...(paths.selfIds || [])]);
    const retro = _goalRetro.buildGoalRetro(goal, contacts, byContact, selfIds);
    json(res, retro);
}

/**
 * GET /api/life-events
 * Returns a ranked list of recently-detected network life events — announcements
 * picked out of message bodies, upcoming birthdays, detected job changes.
 */
function handleGetLifeEvents(req, res, _params, paths) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 12));
    try {
        const contacts = loadContacts(paths);
        const interactions = fs.existsSync(paths.interactions)
            ? JSON.parse(fs.readFileSync(paths.interactions, 'utf8'))
            : [];

        // Build interactionsByContactId using the existing searchIndex
        const { contactMap, contactById } = buildSearchIndex(paths, /*uuid*/ SINGLE_USER_UUID);
        const byContact = {};
        for (const i of interactions) {
            let cid = null;
            if (i.chatId) cid = contactMap[i.chatId];
            if (!cid && typeof i.from === 'string') cid = contactMap[i.from];
            if (!cid && i.source === 'linkedin' && i.chatName) {
                for (const name of i.chatName.split(',').map(n => n.trim())) {
                    if (contactMap[name]) { cid = contactMap[name]; break; }
                }
            }
            if (!cid) continue;
            if (!byContact[cid]) byContact[cid] = [];
            byContact[cid].push(i);
        }

        const events = _lifeEvents.detectAllEvents({ contacts, interactionsByContactId: byContact });
        // Attach company/position for the UI
        for (const e of events) {
            const c = contactById[e.contactId];
            if (c) {
                e.company = c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null;
                e.position = c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null;
            }
        }
        json(res, { count: events.length, events: events.slice(0, limit) });
    } catch (e) {
        json(res, { error: e.message }, 500);
    }
}

/**
 * GET /api/export[?passphrase=<p>]
 * Download the full unified dataset as a portable bundle. Without a passphrase
 * the bundle is gzipped JSON. With a passphrase the gzipped payload is
 * AES-256-GCM encrypted (PBKDF2 200k sha256 key derivation).
 */
function handleExport(req, res, _params, _paths, uuid) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const passphrase = url.searchParams.get('passphrase') || null;
    try {
        const { buffer, filename, encrypted, stats } = _exportModule.exportAll(
            getUserDataDir(uuid),
            { passphrase },
        );
        res.writeHead(200, {
            'Content-Type': encrypted ? 'application/octet-stream' : 'application/gzip',
            'Content-Length': buffer.length,
            'Content-Disposition': 'attachment; filename="' + filename + '"',
            'X-Minty-Bundle-Stats': JSON.stringify(stats),
            'X-Minty-Encrypted': encrypted ? '1' : '0',
        });
        res.end(buffer);
    } catch (e) {
        console.error('[export]', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}
// Cache the mention index — rebuilds only when contacts.json changes.
let _mentionIndex = null;
let _mentionIndexMtime = 0;
function getMentionIndex(contacts) {
    try {
        const st = fs.statSync(path.join(DATA, 'unified/contacts.json'));
        if (st.mtimeMs === _mentionIndexMtime && _mentionIndex) return _mentionIndex;
        _mentionIndex = _mentionsModule.buildMentionIndex(contacts);
        _mentionIndexMtime = st.mtimeMs;
    } catch {
        _mentionIndex = _mentionsModule.buildMentionIndex(contacts);
    }
    return _mentionIndex;
}

const { computeContactMetrics: computeEngagementMetrics, labelMetrics } = require('./response-metrics');

/**
 * Build per-contact engagement metrics from that contact's interactions.
 * Cheap — only runs on detail-view open.
 */
function computeContactEngagement(contact, paths, uuid) {
    try {
        const list = getContactInteractions(contact, paths, uuid);
        if (!list || !list.length) return null;
        const selfIds = new Set(['me', ...(paths.selfIds || [])]);
        // Add the user's own phone if we can infer one (seed data uses 'me', so this is mostly a no-op).
        const decorated = list.map(i => Object.assign({}, i, { _contactId: contact.id }));
        const m = computeEngagementMetrics(decorated, selfIds);
        m.chips = labelMetrics(m);
        return m;
    } catch {
        return null;
    }
}

function handleGetIntroPaths(req, res, [id], paths , ) {
    const contacts = loadContacts(paths);
    const target = contacts.find(c => c.id === id);
    if (!target) return json(res, { error: 'not found' }, 404);
    const memberships = loadGroupMemberships();
    const viewerId = getViewerContactId(paths);
    const excludeIds = [];
    if (viewerId) excludeIds.push(viewerId);
    if (paths.selfIds?.size) excludeIds.push(...paths.selfIds);

    const paths_ = findIntroPaths(id, contacts, memberships, {
        maxPaths: 5,
        maxGroupSize: 200,
        excludeIds,
    });
    json(res, {
        targetId: id,
        targetName: target.name || null,
        count: paths_.length,
        paths: paths_,
    });
}

/**
 * GET /api/intros/find?q=<query>&limit=<n>
 * Fuzzy-match a target across contacts (name/company/position) and, for each
 * top candidate, compute warm-intro paths. Powers the intro finder UI.
 */
function handleFindIntroTargets(req, res, _params, paths) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.max(1, Math.min(10, Number(url.searchParams.get('limit')) || 3));
    if (q.length < 2) return json(res, { query: q, targets: [] });

    const { scoreString } = require('./palette');
    const contacts = loadContacts(paths);
    const memberships = loadGroupMemberships();
    const viewerId = getViewerContactId(paths);
    const excludeIds = [];
    if (viewerId) excludeIds.push(viewerId);
    if (paths.selfIds?.size) excludeIds.push(...paths.selfIds);

    const hits = [];
    for (const c of contacts) {
        if (c.isGroup) continue;
        const name = c.name || '';
        const company = c.sources?.linkedin?.company || c.sources?.googleContacts?.org || '';
        const position = c.sources?.linkedin?.position || c.sources?.googleContacts?.title || '';
        const score = Math.max(
            scoreString(name, q) * 1.5,
            scoreString(company, q),
            scoreString(position, q) * 0.9,
        );
        if (score > 0) hits.push({ c, score });
    }
    hits.sort((a, b) => b.score - a.score);

    const targets = [];
    for (const { c, score } of hits.slice(0, limit)) {
        const pathsFound = findIntroPaths(c.id, contacts, memberships, {
            maxPaths: 5,
            maxGroupSize: 200,
            excludeIds,
        });
        targets.push({
            target: {
                id: c.id, name: c.name,
                company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
                position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
                relationshipScore: c.relationshipScore || 0,
                daysSinceContact: c.daysSinceContact ?? null,
            },
            matchScore: score,
            paths: pathsFound,
        });
    }
    json(res, { query: q, targets });
}

function handleGetInteractions(req, res, [id], paths, uuid) {
    const contact = loadContacts(paths).find(c => c.id === id);
    if (!contact) return json(res, { error: 'not found' }, 404);
    json(res, getContactInteractions(contact, paths, uuid));
}

function handleGetTimeline(req, res, [id], paths, uuid) {
    const contacts = loadContacts(paths);
    const contact = contacts.find(c => c.id === id);
    if (!contact) return json(res, { error: 'not found' }, 404);

    const interactions = getContactInteractions(contact, paths, uuid);
    const now = new Date();
    const months = [];
    for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ year: d.getFullYear(), month: d.getMonth(), count: 0 });
    }

    for (const ix of interactions) {
        if (!ix.timestamp) continue;
        const d = new Date(ix.timestamp);
        const monthsAgo = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
        if (monthsAgo >= 0 && monthsAgo < 24) months[23 - monthsAgo].count++;
    }

    // Relationship arc: compare last 3mo vs prior 3mo
    const last3 = months.slice(-3).reduce((s, m) => s + m.count, 0);
    const prev3 = months.slice(-6, -3).reduce((s, m) => s + m.count, 0);
    let arc = 'stable';
    if (last3 > prev3 * 1.5 && last3 > 2) arc = 'growing';
    else if (prev3 > last3 * 1.5 && prev3 > 2) arc = 'fading';
    else if (last3 > 2 && prev3 === 0) arc = 'revived';

    const firstInteraction = interactions.length
        ? interactions[interactions.length - 1].timestamp
        : null;

    json(res, { months, arc, firstInteraction, totalCount: interactions.length });
}

function handleGetInsights(req, res, [id], paths, uuid) {
    const contacts = loadContacts(paths);
    const contact = contacts.find(c => c.id === id);
    if (!contact) return json(res, { error: 'not found' }, 404);

    const insights = loadInsights(paths);
    const data = insights[id] || null;
    if (!data) return json(res, null);

    // Enrich with last 5 interactions and relationship context
    const recentMsgs = getContactInteractions(contact, paths, uuid).slice(0, 5).map(i => ({
        source: i.source,
        timestamp: i.timestamp,
        snippet: (i.body || i.subject || '').slice(0, 80),
    }));

    const li = contact.sources.linkedin;
    const timeKnownDays = li && li.connectedOn
        ? Math.floor((Date.now() - new Date(li.connectedOn)) / 86400000)
        : null;

    const sourceSplit = data.sourceSplit || {};
    const channelSummary = Object.entries(sourceSplit)
        .sort((a, b) => b[1] - a[1])
        .map(([src, n]) => `${n} ${src}`)
        .join(' · ');

    json(res, { ...data, recentMsgs, timeKnownDays, channelSummary });
}

async function handleRegenerateDraft(req, res, [id], paths) {
    const contacts = loadContacts(paths);
    const contact = contacts.find(c => c.id === id);
    if (!contact) return json(res, { error: 'not found' }, 404);

    const insights = loadInsights(paths);
    const data = insights[id];

    const firstName = (contact.name || '').split(' ')[0] || 'there';

    if (data && data.reconnectDraft) {
        // Shuffle/reframe the pre-computed draft (stub — real improvement via next analyze run)
        const newDraft = regenerateDraft(data.reconnectDraft, firstName);
        return json(res, { draft: newDraft, enhanced: false });
    }

    // Fall back to algorithmic template from contact data
    const recentMsgs = getContactInteractions(contact, paths).slice(0, 3)
        .map(m => (m.body || m.subject || '').slice(0, 80))
        .filter(Boolean);
    const draft = buildReconnectTemplate(contact, data || null, recentMsgs);
    json(res, { draft, enhanced: false });
}

async function handleSaveNotes(req, res, [id], paths , ) {
    const { notes } = await body(req);
    const contacts = loadContacts(paths);
    const contact = contacts.find(c => c.id === id);
    if (!contact) return json(res, { error: 'not found' }, 404);
    contact.notes = notes;
    contact.updatedAt = new Date().toISOString();
    fs.writeFileSync(paths.contacts, JSON.stringify(contacts, null, 2));
    json(res, { ok: true });
}

function handleGetPending(req, res, params, paths , ) {
    const overrides = loadOverrides(paths);
    const contacts = loadContacts(paths);
    const byId = Object.fromEntries(contacts.map(c => [c.id, c]));
    const pending = overrides
        .map((o, idx) => ({ ...o, _idx: idx }))
        .filter(o => o.confidence === 'possible')
        .map(o => ({
            _idx: o._idx, ids: o.ids, names: o.names, reason: o.reason,
            sourceA: o.sourceA || 'whatsapp',
            sourceB: o.sourceB || 'linkedin',
            contactA: byId[o.ids[0]] || null,
            contactB: byId[o.ids[1]] || null,
        }));
    json(res, { total: pending.length, items: pending });
}

async function handleDecide(req, res, params, paths , ) {
    const { idx, decision } = await body(req);
    if (!['confirmed', 'likely', 'unsure', 'skip'].includes(decision))
        return json(res, { error: 'bad decision' }, 400);
    const overrides = loadOverrides(paths);
    if (idx < 0 || idx >= overrides.length)
        return json(res, { error: 'bad idx' }, 400);
    overrides[idx].confidence = decision;
    saveOverrides(overrides, paths);
    json(res, { ok: true, remaining: overrides.filter(o => o.confidence === 'possible').length });
}

function handleGetReconnect(req, res, params, paths, uuid) {
    const contacts = loadContacts(paths);
    const dormant = contacts
        .filter(c => c.name && (c.relationshipScore || 0) >= 50 && (c.daysSinceContact ?? 999) >= 60)
        .sort((a, b) =>
            (b.relationshipScore || 0) * (b.daysSinceContact || 0) -
            (a.relationshipScore || 0) * (a.daysSinceContact || 0))
        .slice(0, 25)
        .map(c => {
            const last = getContactInteractions(c, paths, uuid)[0] || null;
            return {
                id: c.id, name: c.name,
                company: c.sources.linkedin?.company || c.sources.googleContacts?.org || null,
                position: c.sources.linkedin?.position || c.sources.googleContacts?.title || null,
                relationshipScore: c.relationshipScore,
                daysSinceContact: c.daysSinceContact,
                activeChannels: c.activeChannels || [],
                lastSnippet: last ? (last.body || last.subject || '').slice(0, 150) : null,
                lastSource: last?.source || null,
                lastTimestamp: last?.timestamp || null,
            };
        });
    json(res, { count: dormant.length, contacts: dormant });
}

// ---------------------------------------------------------------------------
// Weekly digest
// ---------------------------------------------------------------------------

function handleGetDigest(req, res, params, paths) {
    try { json(res, JSON.parse(fs.readFileSync(paths.digest, 'utf8'))); }
    catch { json(res, null); }
}

// ---------------------------------------------------------------------------
// Introduction opportunity detection
// ---------------------------------------------------------------------------

const INVESTOR_RE  = /\b(investor|vc|venture|partner|angel|fund|capital|managing director)\b/i;
const FOUNDER_RE   = /\b(founder|ceo|co-founder|cofounder|building|startup|stealth)\b/i;
const HIRING_RE    = /\b(head of|director|vp\b|vice president|talent|recruiting|hiring manager)\b/i;
const JOBSEEK_RE   = /\b(looking for|open to|seeking|new opportunity|job search)\b/i;

function contactRole(c) {
    const pos = (c.sources?.linkedin?.position || c.sources?.googleContacts?.title || c.apollo?.title || '').toLowerCase();
    const bio = (c.apollo?.headline || '').toLowerCase();
    const text = pos + ' ' + bio;
    if (INVESTOR_RE.test(text)) return 'investor';
    if (FOUNDER_RE.test(text))  return 'founder';
    if (HIRING_RE.test(text))   return 'hiring';
    return 'other';
}

function sharedDomain(a, b) {
    // Same company (broad match — UCL counts too)
    const aC = (a.sources?.linkedin?.company || a.apollo?.company || '').toLowerCase().trim();
    const bC = (b.sources?.linkedin?.company || b.apollo?.company || '').toLowerCase().trim();
    if (aC && bC && (aC === bC || aC.includes(bC) || bC.includes(aC))) return `both at ${a.sources?.linkedin?.company || aC}`;

    // Both in VC/startup world
    const aRole = contactRole(a), bRole = contactRole(b);
    if (aRole === 'investor' && bRole === 'founder') return 'investor + founder';
    if (aRole === 'founder' && bRole === 'investor') return 'investor + founder';
    if (aRole === 'investor' && bRole === 'investor') return 'both investors';
    if (aRole === 'founder' && bRole === 'founder') return 'both founders';

    // Shared LinkedIn industry (if available)
    const aInd = (a.apollo?.industry || '').toLowerCase();
    const bInd = (b.apollo?.industry || '').toLowerCase();
    if (aInd && bInd && aInd === bInd) return `both in ${a.apollo.industry}`;

    return null;
}

function handleGetIntros(req, res, params, paths , ) {
    const contacts = loadContacts(paths)
        .filter(c => !isGroupContact(c) && c.name && (c.relationshipScore || 0) >= 35)
        .sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0))
        .slice(0, 80); // only top contacts for combinatorics

    const suggestions = [];
    for (let i = 0; i < contacts.length; i++) {
        for (let j = i + 1; j < contacts.length; j++) {
            const a = contacts[i], b = contacts[j];
            const reason = sharedDomain(a, b);
            if (!reason) continue;

            const introValue = Math.round(((a.relationshipScore || 0) + (b.relationshipScore || 0)) / 2);
            const aPos = a.sources?.linkedin?.position || a.sources?.googleContacts?.title || '';
            const bPos = b.sources?.linkedin?.position || b.sources?.googleContacts?.title || '';
            const aCo = a.sources?.linkedin?.company || a.sources?.googleContacts?.org || '';
            const bCo = b.sources?.linkedin?.company || b.sources?.googleContacts?.org || '';

            suggestions.push({
                contactA: { id: a.id, name: a.name, position: aPos, company: aCo, score: a.relationshipScore || 0 },
                contactB: { id: b.id, name: b.name, position: bPos, company: bCo, score: b.relationshipScore || 0 },
                reason,
                introValue,
                template: `Hi ${a.name.split(' ')[0]}, I'd love to connect you with ${b.name}${bPos ? ', ' + bPos : ''}${bCo ? ' at ' + bCo : ''}. ${reason === 'investor + founder' ? "I think you'd find a lot of value talking to each other." : "I think you'd have a lot to talk about."} Would you be open to a quick intro? — Sree`,
            });
        }
    }

    // Sort by intro value descending, deduplicate to show each contact max 3 times
    suggestions.sort((a, b) => b.introValue - a.introValue);
    const contactAppearances = {};
    const top = [];
    for (const s of suggestions) {
        const ca = contactAppearances[s.contactA.id] || 0;
        const cb = contactAppearances[s.contactB.id] || 0;
        if (ca >= 3 || cb >= 3) continue;
        top.push(s);
        contactAppearances[s.contactA.id] = ca + 1;
        contactAppearances[s.contactB.id] = cb + 1;
        if (top.length >= 25) break;
    }

    json(res, { count: top.length, suggestions: top });
}

// ---------------------------------------------------------------------------
// Company network map
// ---------------------------------------------------------------------------

function handleGetCompanies(req, res, params, paths , ) {
    const contacts = loadContacts(paths).filter(c => !isGroupContact(c) && c.name);
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();

    const map = {}; // companyName -> { contacts[], totalScore }
    for (const c of contacts) {
        const company = c.sources?.linkedin?.company || c.sources?.googleContacts?.org || c.apollo?.company || null;
        if (!company) continue;
        const key = company.toLowerCase().trim();
        if (!map[key]) map[key] = { name: company, contacts: [], totalScore: 0 };
        map[key].contacts.push({
            id: c.id,
            name: c.name,
            position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
            relationshipScore: c.relationshipScore || 0,
        });
        map[key].totalScore += c.relationshipScore || 0;
    }

    let companies = Object.values(map)
        .filter(co => co.contacts.length >= 1)
        .map(co => {
            const industry = classifyIndustry(co.name);
            return {
                name: co.name,
                count: co.contacts.length,
                avgScore: Math.round(co.totalScore / co.contacts.length),
                strongest: co.contacts.sort((a, b) => b.relationshipScore - a.relationshipScore)[0],
                contacts: co.contacts.sort((a, b) => b.relationshipScore - a.relationshipScore),
                industry: industry.name,
                industryColor: industry.color,
            };
        });

    if (q) {
        companies = companies.filter(co => co.name.toLowerCase().includes(q));
    } else {
        // Top 40 by contact count, then by avg score
        companies = companies
            .filter(co => co.contacts.length >= 2)
            .sort((a, b) => b.count - a.count || b.avgScore - a.avgScore)
            .slice(0, 40);
    }

    json(res, { count: companies.length, companies });
}

const INDUSTRY_PATTERNS = [
    { name: 'VC/Finance',   color: '#34d399', keywords: ['capital','ventures','fund','vc','investment','goldman','hsbc','barclays','jpmorgan','sequoia','andreessen','blackstone','hedge','asset','equity','bank','financial','finance','money','credit','wealth'] },
    { name: 'Tech',         color: '#60a5fa', keywords: ['google','microsoft','apple','amazon','meta','netflix','spotify','uber','airbnb','stripe','openai','anthropic','software','engineering','tech','digital','data','ai','cloud','saas','platform','startup'] },
    { name: 'Consulting',   color: '#f472b6', keywords: ['deloitte','mckinsey','bain','bcg','ey','kpmg','pwc','accenture','consulting','advisors','advisory','strategy'] },
    { name: 'University',   color: '#a78bfa', keywords: ['university','college','ucl','oxford','cambridge','imperial','lse','mit','harvard','stanford','school','institute','academic','research','phd','professor'] },
    { name: 'Media/PR',     color: '#fbbf24', keywords: ['media','news','press','publishing','marketing','pr','agency','creative','design','studio','film','music','entertainment','brand','content'] },
    { name: 'Health/Bio',   color: '#fb923c', keywords: ['health','medical','pharma','biotech','bio','hospital','nhs','clinical','genomics','life sciences','therapeutics','drug'] },
    { name: 'Gov/Non-profit', color: '#94a3b8', keywords: ['government','gov','policy','ngo','charity','non-profit','nonprofit','foundation','institute for','public','civil service','ministry','parliament'] },
];

function classifyIndustry(companyName) {
    if (!companyName) return { name: 'Other', color: '#4a5568' };
    const lower = companyName.toLowerCase();
    for (const ind of INDUSTRY_PATTERNS) {
        if (ind.keywords.some(kw => lower.includes(kw))) return ind;
    }
    // Check for "Stealth" / early stage
    if (lower.includes('stealth') || lower.includes('self-employed') || lower.includes('freelance')) {
        return { name: 'Indie/Stealth', color: '#c084fc' };
    }
    return { name: 'Other', color: '#4a5568' };
}

function handleGetNetworkEdges(req, res, params, paths , ) {
    // Edges based on LinkedIn connection-date co-activity:
    // Two companies are connected if you connected with people from both during the same quarter.
    // Strength = shared quarters / max(quartersA, quartersB) (Jaccard-like).
    // Build company -> set of quarters from LinkedIn connectedOn dates
    const companyQuarters = {};
    const companyStrongCount = {}; // contacts with score > 0

    const rawContacts = loadContacts(paths);

    function toQuarter(dateStr) {
        if (!dateStr) return null;
        const monthNames = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
        const parts = dateStr.split(' ');
        if (parts.length < 3) return null;
        const month = monthNames[parts[1]];
        const year = parseInt(parts[2]);
        if (month === undefined || isNaN(year)) return null;
        return year + '-Q' + (Math.floor(month / 3) + 1);
    }

    const companyCounts = {};
    for (const c of rawContacts) {
        if (c.isGroup) continue;
        const li = c.sources && c.sources.linkedin;
        const company = li && li.company;
        if (!company) continue;
        companyCounts[company] = (companyCounts[company] || 0) + 1;
        const q = toQuarter(li.connectedOn);
        if (!q) continue;
        if (!companyQuarters[company]) companyQuarters[company] = new Set();
        companyQuarters[company].add(q);
        if ((c.relationshipScore || 0) > 0) {
            companyStrongCount[company] = (companyStrongCount[company] || 0) + 1;
        }
    }

    // Only include top 40 companies (by contact count, same threshold as /api/network/companies)
    const topCompanyNames = new Set(
        Object.entries(companyCounts).sort((a, b) => b[1] - a[1]).slice(0, 40).map(e => e[0])
    );

    const companyList = [...topCompanyNames].filter(c => companyQuarters[c] && companyQuarters[c].size > 0);

    // Compute pairwise edges
    const candidates = [];
    for (let i = 0; i < companyList.length; i++) {
        for (let j = i + 1; j < companyList.length; j++) {
            const a = companyList[i], b = companyList[j];
            const qa = companyQuarters[a], qb = companyQuarters[b];
            const shared = [...qa].filter(q => qb.has(q)).length;
            if (shared < 2) continue; // require at least 2 shared quarters
            const strength = shared / Math.max(qa.size, qb.size);
            const scoreBoost = Math.sqrt(
                (companyStrongCount[a] || 0) * (companyStrongCount[b] || 0)
            );
            candidates.push({ source: a, target: b, shared, strength, scoreBoost });
        }
    }

    // Sort by strength * scoreBoost, cap edges per node at 4
    candidates.sort((a, b) => (b.strength * (1 + b.scoreBoost)) - (a.strength * (1 + a.scoreBoost)));
    const nodeEdgeCount = {};
    const edges = [];
    for (const e of candidates) {
        const ca = nodeEdgeCount[e.source] || 0;
        const cb = nodeEdgeCount[e.target] || 0;
        if (ca >= 4 || cb >= 4) continue;
        edges.push({
            source: e.source,
            target: e.target,
            people: [], // quarters-based, no specific people
            strength: Math.min(e.strength, 1),
            shared: e.shared,
        });
        nodeEdgeCount[e.source] = ca + 1;
        nodeEdgeCount[e.target] = cb + 1;
        if (edges.length >= 60) break;
    }

    json(res, { edges });
}

// ---------------------------------------------------------------------------
// Conversation search index (built once on first search)
// ---------------------------------------------------------------------------

const _searchIndex = {}; // { [uuid]: { interactions: [{...}], contactMap: {chatId/from/email -> contactId} } }

function buildSearchIndex(paths, uuid) {
    if (_searchIndex[uuid]) return _searchIndex[uuid];

    const interactions = JSON.parse(fs.readFileSync(paths.interactions, 'utf8'));
    const contacts = loadContacts(paths).filter(c => !isGroupContact(c));

    // Map from various identifiers -> contactId (for linking results to contacts)
    const contactMap = {};
    for (const c of contacts) {
        if (c.sources?.whatsapp?.id) contactMap[c.sources.whatsapp.id] = c.id;
        for (const p of c.phones || []) contactMap[p] = c.id;
        for (const e of c.emails || []) contactMap[e.toLowerCase()] = c.id;
        if (c.sources?.linkedin?.name) contactMap[c.sources.linkedin.name] = c.id;
        if (c.sources?.sms?.phone) contactMap[c.sources.sms.phone] = c.id;
    }
    const contactById = Object.fromEntries(contacts.map(c => [c.id, c]));

    _searchIndex[uuid] = { interactions, contactMap, contactById };
    console.log(`Search index built for ${uuid} (${interactions.length} interactions)`);
    return _searchIndex[uuid];
}

const { searchInteractions: runSearch } = require('./search');
const { paletteSearch } = require('./palette');

/**
 * GET /api/palette?q=<query>&limit=<n>
 * Unified cross-category search for the Cmd+K palette.
 */
function handlePaletteSearch(req, res, params, paths, uuid) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Number(url.searchParams.get('limit')) || 8;

    const contacts = fs.existsSync(paths.contacts) ? loadContacts(paths) : [];
    const goals = fs.existsSync(paths.goals)
        ? (safeLoadJson(paths.goals) || [])
        : [];

    let interactions = [];
    let contactMap = {};
    let contactById = {};
    if (fs.existsSync(paths.interactions)) {
        const idx = buildSearchIndex(paths, uuid);
        interactions = idx.interactions;
        contactMap = idx.contactMap;
        contactById = idx.contactById;
    }
    // Enrich interactions with _contactId/_contactName so the palette can surface them.
    // Only do this once per process; cache on the search index.
    if (interactions.length && !interactions[0]._decorated) {
        for (const i of interactions) {
            let cid = null;
            if (i.chatId) cid = contactMap[i.chatId];
            if (!cid && typeof i.from === 'string') cid = contactMap[i.from];
            if (!cid && i.source === 'linkedin' && i.chatName) {
                for (const name of i.chatName.split(',').map(n => n.trim())) {
                    if (contactMap[name]) { cid = contactMap[name]; break; }
                }
            }
            i._contactId = cid || null;
            i._contactName = cid ? (contactById[cid]?.name || null) : null;
            i._decorated = true;
        }
    }

    const companies = computeCompanyCounts(contacts);

    const result = paletteSearch(q, {
        contacts, interactions, goals, companies, contactMap, contactById,
    }, { limit });
    json(res, result);
}

function safeLoadJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function computeCompanyCounts(contacts) {
    const map = {};
    for (const c of contacts) {
        if (c.isGroup) continue;
        const co = c.sources?.linkedin?.company || c.sources?.googleContacts?.org;
        if (!co) continue;
        if (!map[co]) map[co] = { name: co, count: 0 };
        map[co].count++;
    }
    return Object.values(map);
}

function handleSearchInteractions(req, res, params, paths, uuid) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json(res, { results: [], query: q });

    const { interactions, contactMap, contactById } = buildSearchIndex(paths, uuid);

    // Decorate interactions with their resolved contact so search.js can filter/emit it.
    // Done lazily once per search — cheap compared to loading the interactions array.
    const enriched = interactions.map(i => {
        let contactId = null;
        if (i.chatId) contactId = contactMap[i.chatId];
        if (!contactId && i.from && typeof i.from === 'string') contactId = contactMap[i.from];
        if (!contactId && i.source === 'linkedin' && i.chatName) {
            for (const name of i.chatName.split(',').map(n => n.trim())) {
                if (contactMap[name]) { contactId = contactMap[name]; break; }
            }
        }
        const contact = contactId ? contactById[contactId] : null;
        return Object.assign({}, i, {
            _contactId: contact?.id || null,
            _contactName: contact?.name || null,
        });
    });

    const opts = {
        limit: Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50)),
        excludeGroups: url.searchParams.get('includeGroups') !== '1',
    };
    const source = url.searchParams.getAll('source');
    if (source.length) opts.source = source;
    const contactId = url.searchParams.get('contactId');
    if (contactId) opts.contactId = contactId;
    const chatId = url.searchParams.get('chatId');
    if (chatId) opts.chatId = chatId;
    const since = url.searchParams.get('since');
    if (since) opts.since = since;
    const until = url.searchParams.get('until');
    if (until) opts.until = until;

    const result = runSearch(enriched, q, opts);
    json(res, {
        query: result.query,
        total: result.total,
        results: result.results.map(r => ({
            source: r.source,
            timestamp: r.timestamp,
            chatId: r.chatId,
            chatName: r.chatName,
            from: r.from,
            to: r.to,
            snippet: r.snippet,
            matches: r.matches,
            // Back-compat fields for existing UI callers
            matchStart: r.matches[0]?.start ?? 0,
            matchLen: r.matches[0]?.length ?? 0,
            contactId: r.contactId,
            contactName: r.contactName,
        })),
    });
}

// ---------------------------------------------------------------------------
// Group chat helpers
// ---------------------------------------------------------------------------

const GROUP_CATEGORIES = [
    [/\b(vc|venture|startup|founder|hatchery|tech|ai|investor|accelerator|angel|pitch|yc|demo day)\b/i, 'professional'],
    [/\b(ucl|lse|imperial|society|fresher|student|university|uni|college|academic|msc|phd|grad)\b/i, 'university'],
    [/\b(run|club|gym|sport|bjj|dance|yoga|football|cricket|tennis|swim|ski|sky|hiking|crossfit)\b/i, 'social'],
    [/\b(home|family|mum|mom|dad|parent|sibling|cousin|uncle|aunt|gang|fam|friends|flatmate)\b/i, 'personal'],
];

function inferGroupCategory(name) {
    for (const [re, cat] of GROUP_CATEGORIES) {
        if (re.test(name)) return cat;
    }
    return 'other';
}

function extractGroupSignals(messages) {
    const urlRe = /https?:\/\/[^\s<>"]+/gi;
    const hiringRe = /\b(hiring|job\b|role\b|apply|opening|recruit|vacancy|looking for|we.re looking)\b/i;
    const eventRe = /\b(event|meetup|meet up|drinks|join us|this (week|weekend|friday|saturday|thursday)|tomorrow|tonight|come along|rsvp)\b/i;
    const introRe = /\b(introduce|let me intro|you (should|must) (meet|know|connect)|connecting you|intro between|putting you two)\b/i;

    const urls = [], hiring = [], events = [], intros = [];
    for (const m of messages) {
        const text = m.body || '';
        if (!text) continue;
        const foundUrls = text.match(urlRe);
        if (foundUrls) {
            for (const url of foundUrls) {
                if (urls.length < 20) urls.push({ url, snippet: text.slice(0, 100), timestamp: m.timestamp });
            }
        }
        if (hiringRe.test(text) && hiring.length < 10) hiring.push({ snippet: text.slice(0, 140), timestamp: m.timestamp });
        if (eventRe.test(text) && events.length < 10) events.push({ snippet: text.slice(0, 140), timestamp: m.timestamp });
        if (introRe.test(text) && intros.length < 10) intros.push({ snippet: text.slice(0, 140), timestamp: m.timestamp });
    }
    return { urls, hiring, events, intros };
}

function loadGroupMemberships() {
    const p = path.join(DATA, 'unified/group-memberships.json');
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function handleGetGroups(req, res, params, paths, uuid) {
    const idx = getInteractionIndex(paths, uuid);
    const memberships = loadGroupMemberships();
    const groupMap = {};

    // Seed from roster data first — captures groups with rosters but zero messages.
    for (const [chatId, g] of Object.entries(memberships)) {
        if (!chatId.endsWith('@g.us')) continue;
        groupMap[chatId] = {
            chatId,
            name: g.name || chatId,
            messageCount: 0,
            lastMessageAt: null,
            lastSnippet: '',
            rosterCount: g.size || 0,
            posterCount: 0,
            category: inferGroupCategory(g.name || chatId),
            owner: g.owner || null,
            createdAt: g.createdAt || null,
            labels: g.labels || [],
        };
    }

    // Layer message data on top.
    for (const [chatId, msgs] of Object.entries(idx.byChatId)) {
        if (!chatId.endsWith('@g.us')) continue;
        const sorted = [...msgs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const name = sorted[0]?.chatName || chatId;
        const posters = new Set(msgs.map(m => m.from).filter(Boolean));
        const existing = groupMap[chatId] || {
            chatId, name, rosterCount: 0, posterCount: 0,
            category: inferGroupCategory(name), owner: null, createdAt: null, labels: [],
        };
        groupMap[chatId] = {
            ...existing,
            name: existing.name || name,
            messageCount: msgs.length,
            lastMessageAt: sorted[0]?.timestamp || null,
            lastSnippet: (sorted[0]?.body || '').slice(0, 100),
            posterCount: posters.size,
        };
    }

    // Back-compat: keep participantCount as the higher of roster/poster counts.
    const groups = Object.values(groupMap).map(g => ({
        ...g,
        participantCount: Math.max(g.rosterCount || 0, g.posterCount || 0),
    })).sort((a, b) => {
        if (!a.lastMessageAt && !b.lastMessageAt) {
            return (b.rosterCount || 0) - (a.rosterCount || 0);
        }
        if (!a.lastMessageAt) return 1;
        if (!b.lastMessageAt) return -1;
        return new Date(b.lastMessageAt) - new Date(a.lastMessageAt);
    });
    json(res, { count: groups.length, groups });
}

function loadWhatsAppChatsRaw() {
    try {
        return JSON.parse(fs.readFileSync(path.join(DATA, 'whatsapp/chats.json'), 'utf8')) || {};
    } catch { return {}; }
}

/**
 * GET /api/settings — current mode, data dir, demo dataset stats.
 */
function handleGetSettings(_req, res) {
    const demoDir = path.join(__dirname, '../data-demo');
    const realDir = path.join(__dirname, '../data');
    const stat = (dir) => {
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(dir, 'unified/contacts.json'), 'utf8'));
            const ix = JSON.parse(fs.readFileSync(path.join(dir, 'unified/interactions.json'), 'utf8'));
            return { contacts: cs.length, interactions: ix.length };
        } catch { return { contacts: 0, interactions: 0 }; }
    };
    json(res, {
        currentMode: IS_DEMO ? 'demo' : 'real',
        dataDir: DATA,
        persistedMode: readPersistedMode(),
        demo: { dir: demoDir, ...stat(demoDir) },
        real: { dir: realDir, ...stat(realDir) },
        envOverride: !!(process.env.CRM_DATA_DIR || process.env.MINTY_DEMO),
        runtimeConfig: userConfig.getRedactedConfig(DATA),
        playwrightAvailable: linkedInPlaywrightAvailable(),
    });
}

/**
 * POST /api/settings/linkedin-autosync  { enabled: boolean }
 * Persists to data/config.json and immediately fires a manual run if turning
 * on (so the user doesn't wait 90s for the boot kick to elapse).
 */
async function handleSetLinkedinAutosync(req, res) {
    if (userConfig.envForces('linkedinAutosync')) {
        return json(res, { error: 'MINTY_LINKEDIN_AUTOSYNC env var is set — unset it to control from the UI' }, 409);
    }
    const body_ = await body(req);
    const enabled = !!(body_ && body_.enabled);
    userConfig.updateConfig(DATA, { linkedinAutosync: enabled });
    if (enabled) {
        try { syncDaemons[SINGLE_USER_UUID]?.triggerLinkedInSync?.(); }
        catch (e) { console.error('[settings] LinkedIn manual trigger failed:', e.message); }
    }
    json(res, { ok: true, enabled, runtimeConfig: userConfig.getRedactedConfig(DATA) });
}

/**
 * POST /api/settings/oauth  { provider: 'google'|'microsoft', clientId, clientSecret? }
 * clientSecret is optional — omit to keep the previously-set value.
 */
async function handleSetOAuthConfig(req, res) {
    const body_ = await body(req);
    const provider = body_ && body_.provider;
    if (!['google', 'microsoft'].includes(provider)) {
        return json(res, { error: 'provider must be "google" or "microsoft"' }, 400);
    }
    const patch = { [provider]: {} };
    if (typeof body_.clientId === 'string') patch[provider].clientId = body_.clientId.trim();
    if (typeof body_.clientSecret === 'string' && body_.clientSecret.length > 0) {
        patch[provider].clientSecret = body_.clientSecret;
    }
    userConfig.updateConfig(DATA, patch);
    json(res, { ok: true, runtimeConfig: userConfig.getRedactedConfig(DATA) });
}

/**
 * POST /api/settings/mode  { mode: 'demo' | 'real' }
 * Persists the mode to minty-mode.json. Server-side data dir is bound at
 * boot, so a switch needs a restart — we surface that clearly.
 */
async function handleSetMode(req, res) {
    const body_ = await body(req);
    const mode = body_ && body_.mode;
    if (!['demo', 'real'].includes(mode)) {
        return json(res, { error: 'mode must be "demo" or "real"' }, 400);
    }
    writePersistedMode(mode);
    const current = IS_DEMO ? 'demo' : 'real';
    json(res, {
        ok: true,
        savedMode: mode,
        currentMode: current,
        restartRequired: mode !== current,
    });
}

/**
 * POST /api/settings/seed-demo
 * Regenerates data-demo from scratch using scripts/seed-dev-data.js.
 * Useful after pulling new fixture changes.
 */
async function handleSeedDemo(_req, res) {
    const { execFileSync } = require('child_process');
    try {
        const demoDir = path.join(__dirname, '../data-demo');
        const out = execFileSync('node', [path.join(__dirname, '../scripts/seed-dev-data.js'), '--clean'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, CRM_DATA_DIR: demoDir },
            encoding: 'utf8',
            timeout: 60000,
        });
        json(res, { ok: true, output: out.split('\n').slice(-10).join('\n') });
    } catch (e) {
        json(res, { error: e.message }, 500);
    }
}

function loadLidMap() {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, 'whatsapp/lid-map.json'), 'utf8')) || {}; }
    catch { return {}; }
}

function saveLidMap(map) {
    const p = path.join(DATA, 'whatsapp/lid-map.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(map, null, 2));
}

/**
 * POST /api/whatsapp/lid-map  { mapping: { "<lid@lid>": "<contactId or @c.us id>" } }
 * Persists user-curated @lid → contact assignments. Clears the in-memory
 * resolver caches so the new mapping takes effect on the next group fetch
 * without needing a full merge re-run.
 */
async function handleSaveLidMap(req, res, _params, paths) {
    const body_ = await body(req);
    const mapping = body_ && body_.mapping;
    if (!mapping || typeof mapping !== 'object') {
        return json(res, { error: 'mapping object required' }, 400);
    }
    const current = loadLidMap();
    const contacts = loadContacts(paths);
    const byContactId = new Map(contacts.map(c => [c.id, c]));

    let added = 0, removed = 0;
    for (const [lid, target] of Object.entries(mapping)) {
        if (!lid.endsWith('@lid')) continue;
        if (target === null || target === '') {
            if (current[lid]) { delete current[lid]; removed++; }
            continue;
        }
        // target may be a contact id (e.g. wa_447383719797) or already a @c.us id.
        let resolvedTo = target;
        if (!String(target).endsWith('@c.us') && !String(target).endsWith('@lid')) {
            const c = byContactId.get(target);
            if (c?.sources?.whatsapp?.id && c.sources.whatsapp.id.endsWith('@c.us')) {
                resolvedTo = c.sources.whatsapp.id;
            } else if (c?.phones?.[0]) {
                const digits = String(c.phones[0]).replace(/[^0-9]/g, '');
                resolvedTo = digits + '@c.us';
            } else {
                continue; // can't map without an @c.us anchor
            }
        }
        current[lid] = resolvedTo;
        added++;
    }
    saveLidMap(current);
    // Clear caches so the resolver picks up the new map immediately.
    Object.keys(_interactionIndex).forEach(k => delete _interactionIndex[k]);
    Object.keys(_searchIndex).forEach(k => delete _searchIndex[k]);
    json(res, { ok: true, added, removed, totalMappings: Object.keys(current).length });
}

function handleGetGroupDetail(req, res, [chatId], paths, uuid) {
    const idx = getInteractionIndex(paths, uuid);
    const msgs = idx.byChatId[chatId] || [];
    const rawChats = loadWhatsAppChatsRaw();

    // Find the raw chat entry (keyed by name in chats.json) whose meta.id matches.
    let rawChatEntry = null;
    for (const entry of Object.values(rawChats)) {
        if (entry?.meta?.id === chatId) { rawChatEntry = entry; break; }
    }

    const memberships = loadGroupMemberships();
    const membership = memberships[chatId] || null;

    // If there are no messages AND no roster record, treat as not found.
    if (msgs.length === 0 && !membership && !rawChatEntry) {
        return json(res, { error: 'not found' }, 404);
    }

    const sorted = [...msgs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const name = sorted[0]?.chatName || rawChatEntry?.meta?.name || membership?.name || chatId;
    const category = inferGroupCategory(name);
    const signals = extractGroupSignals(sorted);
    const pinnedMessages = rawChatEntry?.meta?.pinnedMessages || [];

    // Resolve `from` (WA ids like 12847989915@c.us) to contact display name
    // so the UI shows "Hana Abebe" instead of a raw phone number.
    const resolveFrom = buildWhatsappFromResolver(paths);

    // Roster: hydrate member contact ids → name + role for the participant list.
    const contacts = loadContacts(paths);
    const byContactId = new Map(contacts.map(c => [c.id, c]));
    const roster = (membership?.members || []).map(cid => {
        const c = byContactId.get(cid);
        if (!c) return null;
        return {
            id: c.id,
            name: c.name || formatPhoneFallback(c) || '(unknown)',
            phones: c.phones || [],
            position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
            company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
            relationshipScore: c.relationshipScore || 0,
        };
    }).filter(Boolean);

    // Aggregate unresolved @lid senders so the UI can offer a labelling
    // affordance. For each anon-lid id we surface message count + a sample
    // body, plus suggestedContacts (named roster members the user hasn't
    // seen as a known sender yet — best candidates for the assignment).
    const senderStats = {}; // sender id → { count, sample, kind }
    for (const m of sorted) {
        if (!m.from) continue;
        if (!senderStats[m.from]) senderStats[m.from] = { id: m.from, count: 0, sample: '', kind: null };
        senderStats[m.from].count++;
        if (!senderStats[m.from].sample && m.body) senderStats[m.from].sample = m.body.slice(0, 80);
    }
    const seenContactIds = new Set();
    for (const sid of Object.keys(senderStats)) {
        const r = resolveFrom(sid);
        senderStats[sid].kind = r.kind;
        senderStats[sid].name = r.name;
        if (r.contactId) seenContactIds.add(r.contactId);
    }
    const unresolvedSenders = Object.values(senderStats)
        .filter(s => s.kind === 'anon-lid' || (s.kind === 'phone' && s.id && s.id.endsWith('@lid')))
        .sort((a, b) => b.count - a.count);
    // Suggest roster members not already attributed to any sender — most likely
    // candidates for the @lid behind the messages.
    const candidateRoster = roster.filter(r => !seenContactIds.has(r.id));

    json(res, {
        chatId,
        name,
        category,
        messageCount: msgs.length,
        lastMessageAt: sorted[0]?.timestamp || null,
        messages: sorted.slice(0, 50).map(m => {
            const r = resolveFrom(m.from);
            return {
                timestamp: m.timestamp,
                from: m.from,
                fromName: r.name,
                fromContactId: r.contactId,
                fromKind: r.kind,
                body: m.body || '',
            };
        }),
        unresolvedSenders,
        suggestedContacts: candidateRoster,
        pinnedMessages: pinnedMessages.map(m => {
            const r = resolveFrom(m.from || m.author);
            return { ...m, fromName: r.name, fromContactId: r.contactId, fromKind: r.kind };
        }),
        rosterCount: membership?.size || 0,
        roster,
        owner: membership?.owner || rawChatEntry?.meta?.owner || null,
        createdAt: membership?.createdAt || rawChatEntry?.meta?.createdAt || null,
        description: membership?.description || rawChatEntry?.meta?.description || null,
        signals,
    });
}

/**
 * Build a function: rawFrom (e.g. "12847989915@c.us", "+12847989915", "me") →
 *   { name, contactId } using the loaded contact list.
 *
 * Also returns a graceful fallback for ids we can't resolve so the UI never
 * has to display a raw @c.us / phone number.
 */
function buildWhatsappFromResolver(paths) {
    const contacts = loadContacts(paths);
    const byKey = new Map();
    // lid-map.json bridges @lid → @c.us when the user has the mapping
    let lidMap = {};
    try {
        lidMap = JSON.parse(fs.readFileSync(path.join(DATA, 'whatsapp/lid-map.json'), 'utf8')) || {};
    } catch { lidMap = {}; }

    for (const c of contacts) {
        if (c.sources?.whatsapp?.id) byKey.set(c.sources.whatsapp.id, c);
        for (const phone of c.phones || []) {
            const digits = String(phone).replace(/[^0-9]/g, '');
            if (digits) {
                byKey.set(digits, c);
                byKey.set(digits + '@c.us', c);
                byKey.set('+' + digits, c);
            }
        }
    }
    return function resolve(rawFrom) {
        if (!rawFrom) return { name: null, contactId: null, kind: 'unknown' };
        if (rawFrom === 'me' || rawFrom === 'Me') return { name: 'You', contactId: null, kind: 'self' };

        // 1) Try direct id match
        let c = byKey.get(rawFrom);
        // 2) For @lid: try the lid-map first, then fall through to digit lookup
        if (!c && typeof rawFrom === 'string' && rawFrom.endsWith('@lid')) {
            const mapped = lidMap[rawFrom];
            if (mapped) c = byKey.get(mapped) || byKey.get(String(mapped).replace(/[^0-9]/g, ''));
        }
        // 3) Phone-digit lookup catches the @c.us variants
        if (!c) c = byKey.get(String(rawFrom).replace(/[^0-9]/g, ''));
        if (!c) c = byKey.get(String(rawFrom).split('@')[0]);

        if (c && c.name) return { name: c.name, contactId: c.id, kind: 'named' };
        if (c) {
            const phone = formatPhoneFallback(c);
            const isLidOnly = c.isAnonymousLid
                || (c.sources?.whatsapp?.id && c.sources.whatsapp.id.endsWith('@lid'));
            if (isLidOnly && !phone) {
                return { name: 'Group member', contactId: c.id, kind: 'anon-lid' };
            }
            return {
                name: phone || 'Group member',
                contactId: c.id,
                kind: phone ? 'phone' : 'anon-lid',
            };
        }

        // 4) Unresolved — humanise raw forms
        if (typeof rawFrom === 'string') {
            if (rawFrom.endsWith('@lid')) {
                // Truly anonymous — the @lid isn't in lidMap and isn't a saved contact
                return { name: 'Group member', contactId: null, kind: 'anon-lid' };
            }
            if (rawFrom.endsWith('@c.us')) {
                const digits = rawFrom.split('@')[0];
                return { name: formatPhoneNumber('+' + digits), contactId: null, kind: 'phone' };
            }
            if (rawFrom.endsWith('@g.us')) {
                // Should never reach the message-from path after the merge.js
                // group `author`-vs-`from` fix; defensive fallback only.
                return { name: 'Group', contactId: null, kind: 'group' };
            }
        }
        return { name: String(rawFrom), contactId: null, kind: 'raw' };
    };
}

/**
 * Pretty-print a phone number into a human-readable form when no name exists.
 * Best-effort — a full libphonenumber port isn't worth the dependency.
 */
function formatPhoneNumber(p) {
    if (!p) return null;
    const digits = String(p).replace(/[^0-9]/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
        return '+1 (' + digits.slice(1, 4) + ') ' + digits.slice(4, 7) + '-' + digits.slice(7);
    }
    if (digits.length === 12 && digits.startsWith('44')) {
        return '+44 ' + digits.slice(2, 6) + ' ' + digits.slice(6);
    }
    if (digits.length >= 8) return '+' + digits;
    return p;
}

function formatPhoneFallback(c) {
    if (c.phones && c.phones.length) return formatPhoneNumber(c.phones[0]);
    return null;
}

function handleRunMerge(req, res, params, paths , ) {
    Object.keys(_interactionIndex).forEach(k => delete _interactionIndex[k]);
    Object.keys(_searchIndex).forEach(k => delete _searchIndex[k]);
    const out = execSync('node crm/merge.js', {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 30000,
    });
    json(res, { ok: true, output: out });
}

// ---------------------------------------------------------------------------
// Source connection helpers
// ---------------------------------------------------------------------------

function getUserDataDir(uuid) {
    return DATA;
}

// Source metadata (accounts, updatedAt timestamps) persisted to data/sources.json
const SOURCES_META_PATH = path.join(DATA, 'sources.json');

function loadSourcesMeta() {
    try { return JSON.parse(fs.readFileSync(SOURCES_META_PATH, 'utf8')); } catch { return {}; }
}

function saveSourcesMeta(meta) {
    fs.writeFileSync(SOURCES_META_PATH, JSON.stringify(meta, null, 2));
    // Contains OAuth access + refresh tokens. Restrict to owner on POSIX;
    // on Windows this is a no-op but harmless.
    try { fs.chmodSync(SOURCES_META_PATH, 0o600); } catch { /* ignore */ }
}

function updateUserSource(uuid, source, info) {
    const meta = loadSourcesMeta();
    if (!meta[source]) meta[source] = {};
    meta[source] = { ...meta[source], ...info, updatedAt: new Date().toISOString() };
    saveSourcesMeta(meta);
}

function rawBody(req, max = UPLOAD_BODY_MAX) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > max) { req.destroy(); reject(new Error('payload too large')); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function parseMultipart(buffer, boundary) {
    const parts = [];
    const sep = Buffer.from('\r\n--' + boundary);
    const first = '--' + boundary + '\r\n';
    let pos = buffer.indexOf(first);
    if (pos === -1) return parts;
    pos += first.length - 2; // point to \r\n before first header
    while (pos < buffer.length) {
        const headerStart = buffer.indexOf('\r\n', pos) + 2;
        const headerEnd = buffer.indexOf('\r\n\r\n', headerStart);
        if (headerEnd === -1) break;
        const headers = buffer.slice(headerStart, headerEnd).toString();
        const contentStart = headerEnd + 4;
        const contentEnd = buffer.indexOf(sep, contentStart);
        if (contentEnd === -1) break;
        const name = headers.match(/name="([^"]+)"/)?.[1];
        const filename = headers.match(/filename="([^"]+)"/)?.[1];
        parts.push({ name, filename, content: buffer.slice(contentStart, contentEnd) });
        pos = contentEnd + sep.length;
        if (buffer.slice(pos, pos + 2).toString() === '--') break;
        pos += 2; // skip \r\n
    }
    return parts;
}

function runImporter(script, env) {
    const { execFileSync } = require('child_process');
    const root = path.join(__dirname, '..');
    execFileSync('node', [script], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 120000,
    });
}

function runMerge(userDataDir, outDir) {
    const { execFileSync } = require('child_process');
    const root = path.join(__dirname, '..');
    execFileSync('node', ['crm/merge.js'], {
        cwd: root,
        env: { ...process.env, CRM_DATA_DIR: userDataDir, CRM_OUT_DIR: outDir },
        encoding: 'utf8',
        timeout: 120000,
    });
}

function handleGetSources(req, res, params, paths, uuid) {
    const sources = loadSourcesMeta();
    const dataDir = getUserDataDir(uuid);
    const sourceNames = ['whatsapp', 'linkedin', 'telegram', 'email', 'googleContacts', 'sms'];
    const result = {};
    for (const s of sourceNames) {
        const folderName = s === 'googleContacts' ? 'google-contacts' : s;
        const contactsPath = path.join(dataDir, folderName, 'contacts.json');
        const hasData = fs.existsSync(contactsPath);
        // For email, include the accounts list (strip tokens)
        const sourceMeta = { ...sources[s], hasData };
        if (s === 'email' && sources[s]?.accounts) {
            sourceMeta.accounts = sources[s].accounts.map(a => ({ email: a.email, provider: a.provider, connectedAt: a.connectedAt }));
        }
        // Include contact count for connected sources
        if (hasData) {
            try {
                const contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
                sourceMeta.contactCount = Array.isArray(contacts)
                    ? contacts.length
                    : (contacts && typeof contacts === 'object' ? Object.keys(contacts).length : 0);
            } catch { sourceMeta.contactCount = 0; }
        }
        result[s] = sourceMeta;
    }
    // Also indicate whether Google OAuth is configured
    result._googleOAuthEnabled = !!(userConfig.getGoogleClient(DATA).id && userConfig.getGoogleClient(DATA).secret);
    result._microsoftOAuthEnabled = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
    result._linkedinAutoSyncEnabled = linkedinAutosyncEnabled();
    // Include playwrightAvailable so the SPA can show "install needed" hints
    // without polling /api/linkedin/status separately. Fixes the pwMissing
    // logic in renderSourceForm that was always falsy because this field was
    // only populated by /api/linkedin/status, not by /api/sources.
    result._linkedin = linkedinAutosyncEnabled()
        ? { ...readLinkedInState(), playwrightAvailable: linkedInPlaywrightAvailable() }
        : { status: 'disconnected', playwrightAvailable: false };
    json(res, result);
}

async function handleUploadSource(req, res, [source], paths, uuid) {
    const ct = req.headers['content-type'] || '';
    const boundary = ct.match(/boundary=(.+)/)?.[1];
    if (!boundary) return json(res, { error: 'missing boundary' }, 400);

    const buf = await rawBody(req);
    const parts = parseMultipart(buf, boundary);
    if (!parts.length) return json(res, { error: 'no file received' }, 400);

    const dataDir = getUserDataDir(uuid);
    const folderName = source === 'googleContacts' ? 'google-contacts' : source;
    const uploadsDir = path.join(dataDir, 'uploads', folderName);
    fs.mkdirSync(uploadsDir, { recursive: true });

    // Save each uploaded file — sanitize filename to prevent path traversal
    for (const part of parts) {
        if (!part.filename) continue;
        const safeName = path.basename(part.filename).replace(/^\.+/, '');
        if (!safeName || safeName !== part.filename) {
            return json(res, { error: 'invalid filename' }, 400);
        }
        part.safeName = safeName;
        fs.writeFileSync(path.join(uploadsDir, safeName), part.content);
    }

    // Run the appropriate importer
    const sourceOutDir = path.join(dataDir, folderName);
    try {
        if (source === 'linkedin') {
            runImporter('sources/linkedin/import.js', {
                LINKEDIN_EXPORT_DIR: uploadsDir,
                LINKEDIN_OUT_DIR: sourceOutDir,
            });
        } else if (source === 'googleContacts') {
            const vcfFile = parts.find(p => p.filename?.endsWith('.vcf'));
            if (vcfFile) {
                const vcfPath = path.join(uploadsDir, vcfFile.filename);
                runImporter('sources/google-contacts/import.js', {
                    GOOGLE_CONTACTS_FILE: vcfPath,
                    GOOGLE_CONTACTS_OUT_DIR: sourceOutDir,
                });
            }
        } else if (source === 'telegram') {
            const jsonFile = parts.find(p => p.filename?.endsWith('.json'));
            if (jsonFile) {
                const jsonPath = path.join(uploadsDir, jsonFile.filename);
                runImporter('sources/telegram/import.js', {
                    TELEGRAM_EXPORT_FILE: jsonPath,
                    TELEGRAM_OUT_DIR: sourceOutDir,
                });
            }
        } else if (source === 'sms') {
            runImporter('sources/sms/import.js', {
                SMS_EXPORT_DIR: uploadsDir,
                SMS_OUT_DIR: sourceOutDir,
            });
        }

        // Run merge
        const outDir = paths.contacts ? path.dirname(paths.contacts) : path.join(dataDir, 'unified');
        fs.mkdirSync(outDir, { recursive: true });
        runMerge(dataDir, outDir);
        delete _interactionIndex[uuid];
        delete _searchIndex[uuid];

        updateUserSource(uuid, source, { connectedAt: new Date().toISOString(), status: 'connected' });
        json(res, { ok: true });
    } catch (e) {
        console.error(e);
        json(res, { error: e.message }, 500);
    }
}

async function handleConnectEmail(req, res, params, paths, uuid) {
    const { host, user, pass, port, mailbox, limit } = await body(req);
    if (!host || !user || !pass) return json(res, { error: 'host, user, pass required' }, 400);

    const dataDir = getUserDataDir(uuid);
    const outDir = path.join(dataDir, 'email');
    fs.mkdirSync(outDir, { recursive: true });

    try {
        runImporter('sources/email/import.js', {
            EMAIL_HOST: host, EMAIL_USER: user, EMAIL_PASS: pass,
            EMAIL_PORT: String(port || 993),
            EMAIL_MAILBOX: mailbox || 'INBOX',
            EMAIL_LIMIT: String(limit || 1000),
            EMAIL_OUT_DIR: outDir,
        });

        const mergeOut = paths.contacts ? path.dirname(paths.contacts) : path.join(dataDir, 'unified');
        fs.mkdirSync(mergeOut, { recursive: true });
        runMerge(dataDir, mergeOut);
        delete _interactionIndex[uuid];
        delete _searchIndex[uuid];

        // Save credentials (masked) to user entry
        updateUserSource(uuid, 'email', { host, user, port: port || 993, status: 'connected', connectedAt: new Date().toISOString() });
        json(res, { ok: true });
    } catch (e) {
        console.error(e);
        json(res, { error: e.message }, 500);
    }
}

// ── Google OAuth / Gmail API ───────────────────────────────────────────────

// ── OAuth helpers ───────────────────────────────────────────────────────────
// Google: uses redirect flow (device flow blocks gmail.readonly scope)
// Microsoft: uses device flow (no redirect URI needed)

const deviceFlows = {}; // uuid+provider -> { device_code, interval, expiresAt }
const pendingOAuth = {}; // state -> { uuid, expiresAt }

function oauthCallbackUrl(req) {
    const host = req.headers.host || `localhost:${PORT}`;
    return `http://${host}/oauth/callback`;
}

function httpsPost(hostname, path, bodyStr) {
    return new Promise((resolve, reject) => {
        const req = require('https').request({
            hostname, path, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bodyStr) },
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
        });
        req.on('error', reject); req.write(bodyStr); req.end();
    });
}

function httpsGet(hostname, path, token) {
    return new Promise((resolve, reject) => {
        require('https').get({
            hostname, path,
            headers: { Authorization: 'Bearer ' + token },
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
        }).on('error', reject);
    });
}

async function handleEmailDeviceStart(req, res, params, paths, uuid) {
    const { provider } = await body(req);
    if (provider === 'google') {
        if (!userConfig.getGoogleClient(DATA).id) return json(res, { error: 'Google OAuth client ID not set — open Settings to configure' }, 400);
        const state = crypto.randomBytes(16).toString('hex');
        pendingOAuth[state] = { uuid, expiresAt: Date.now() + 10 * 60 * 1000, purpose: 'gmail' };
        res.setHeader('Set-Cookie', `oauth_state=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600`);
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
            client_id: userConfig.getGoogleClient(DATA).id,
            redirect_uri: oauthCallbackUrl(req),
            response_type: 'code',
            scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
            access_type: 'offline',
            prompt: 'consent',
            state,
        });
        return json(res, { auth_url: authUrl });
    }
    if (provider === 'microsoft') {
        if (!process.env.MICROSOFT_CLIENT_ID) return json(res, { error: 'MICROSOFT_CLIENT_ID not set' }, 400);
        const r = await httpsPost('login.microsoftonline.com', '/common/oauth2/v2.0/devicecode',
            new URLSearchParams({ client_id: process.env.MICROSOFT_CLIENT_ID,
                scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access' }).toString());
        if (r.error) return json(res, { error: r.error_description || r.error }, 400);
        deviceFlows[uuid + ':microsoft'] = { device_code: r.device_code, interval: r.interval || 5,
            expiresAt: Date.now() + r.expires_in * 1000 };
        return json(res, { user_code: r.user_code, verification_url: r.verification_uri });
    }
    json(res, { error: 'unknown provider' }, 400);
}

async function handleEmailDevicePoll(req, res, params, paths, uuid) {
    const url = new URL(req.url, 'http://localhost');
    const provider = url.searchParams.get('provider');
    const key = uuid + ':' + provider;
    const flow = deviceFlows[key];
    if (!flow) return json(res, { status: 'error', message: 'No pending flow. Click the button again.' });
    if (Date.now() > flow.expiresAt) { delete deviceFlows[key]; return json(res, { status: 'expired' }); }

    let tokens;
    try {
        if (provider === 'google') {
            tokens = await httpsPost('oauth2.googleapis.com', '/token',
                new URLSearchParams({ client_id: userConfig.getGoogleClient(DATA).id,
                    client_secret: userConfig.getGoogleClient(DATA).secret,
                    device_code: flow.device_code,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString());
        } else {
            tokens = await httpsPost('login.microsoftonline.com', '/common/oauth2/v2.0/token',
                new URLSearchParams({ client_id: process.env.MICROSOFT_CLIENT_ID,
                    device_code: flow.device_code,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString());
        }
    } catch (e) { return json(res, { status: 'error', message: e.message }); }

    if (tokens.error === 'authorization_pending' || tokens.error === 'slow_down') {
        return json(res, { status: 'pending' });
    }
    if (tokens.error) {
        delete deviceFlows[key];
        return json(res, { status: 'error', message: tokens.error_description || tokens.error });
    }

    // Got tokens — save and import
    delete deviceFlows[key];
    let emailAddr;
    try {
        if (provider === 'google') {
            const info = await httpsGet('www.googleapis.com', '/oauth2/v2/userinfo', tokens.access_token);
            emailAddr = info.email;
        } else {
            const info = await httpsGet('graph.microsoft.com', '/v1.0/me?$select=mail,userPrincipalName', tokens.access_token);
            emailAddr = info.mail || info.userPrincipalName;
        }
    } catch { emailAddr = null; }

    const meta = loadSourcesMeta();
    meta.email = meta.email || {};
    const accounts = meta.email.accounts || [];
    const existing = accounts.findIndex(a => a.email === emailAddr);
    const entry = { email: emailAddr, provider,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || accounts[existing]?.refreshToken,
        connectedAt: new Date().toISOString() };
    if (existing >= 0) accounts[existing] = entry; else accounts.push(entry);
    meta.email.accounts = accounts;
    meta.email.status = 'connected';
    meta.email.connectedAt = entry.connectedAt;
    saveSourcesMeta(meta);

    const dataDir = getUserDataDir(uuid);
    const outDir = path.join(dataDir, 'email');
    fs.mkdirSync(outDir, { recursive: true });
    runImporter('sources/email/import.js', {
        EMAIL_ACCESS_TOKEN: tokens.access_token,
        EMAIL_TOKEN_TYPE: provider === 'microsoft' ? 'microsoft' : 'google',
        EMAIL_LIMIT: '1000', EMAIL_OUT_DIR: outDir,
    });
    const mergeOut = path.join(dataDir, 'unified');
    fs.mkdirSync(mergeOut, { recursive: true });
    runMerge(dataDir, mergeOut);
    delete _interactionIndex[uuid];
    delete _searchIndex[uuid];

    // Also auto-fetch Google Contacts if scope allows
    if (provider === 'google') {
        try {
            const contacts = await fetchContactsFromPeopleAPI(tokens.access_token);
            const gcOutDir = path.join(dataDir, 'google-contacts');
            fs.mkdirSync(gcOutDir, { recursive: true });
            fs.writeFileSync(path.join(gcOutDir, 'contacts.json'), JSON.stringify(contacts, null, 2));
            const m2 = loadSourcesMeta();
            m2.googleContacts = { status: 'connected', syncedAt: new Date().toISOString(), count: contacts.length };
            saveSourcesMeta(m2);
            runMerge(dataDir, mergeOut);
            delete _interactionIndex[uuid];
            delete _searchIndex[uuid];
            console.log(`Auto-synced ${contacts.length} Google Contacts for ${emailAddr}`);
        } catch (e) {
            console.log('Google Contacts auto-sync skipped (scope not yet granted):', e.message);
        }
    }

    json(res, { status: 'done', email: emailAddr });
}

async function handleGoogleContactsOAuthStart(req, res, params, paths, uuid) {
    if (!userConfig.getGoogleClient(DATA).id) return json(res, { error: 'Google OAuth client ID not set — open Settings to configure' }, 400);
    const state = crypto.randomBytes(16).toString('hex');
    pendingOAuth[state] = { uuid, expiresAt: Date.now() + 10 * 60 * 1000, purpose: 'google-contacts' };
    res.setHeader('Set-Cookie', `oauth_state=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600`);
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: userConfig.getGoogleClient(DATA).id,
        redirect_uri: oauthCallbackUrl(req),
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email',
        access_type: 'offline',
        prompt: 'consent',
        state,
    });
    json(res, { auth_url: authUrl });
}

async function fetchContactsFromPeopleAPI(accessToken) {
    const contacts = [];
    let pageToken = null;
    const fields = 'names,emailAddresses,phoneNumbers,organizations,biographies,birthdays,urls';
    do {
        const qs = `/v1/people/me/connections?personFields=${fields}&pageSize=1000` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
        const res = await httpsGet('people.googleapis.com', qs, accessToken);
        if (res.error) throw new Error('People API error: ' + JSON.stringify(res.error));
        for (const p of (res.connections || [])) {
            const name = p.names?.[0]?.displayName || null;
            const phones = (p.phoneNumbers || []).map(ph => {
                const normalized = (ph.value || '').replace(/[^0-9+]/g, '');
                return normalized.length >= 7 ? { number: normalized, types: ph.type ? [ph.type.toUpperCase()] : [] } : null;
            }).filter(Boolean);
            const emails = (p.emailAddresses || []).map(em => {
                const email = (em.value || '').toLowerCase().trim();
                return email.includes('@') ? { email, types: em.type ? [em.type.toUpperCase()] : [] } : null;
            }).filter(Boolean);
            const org = p.organizations?.[0]?.name || null;
            const title = p.organizations?.[0]?.title || null;
            const note = p.biographies?.[0]?.value || null;
            const bd = p.birthdays?.[0]?.date;
            const birthday = bd ? `${bd.year || ''}-${String(bd.month || '').padStart(2,'0')}-${String(bd.day || '').padStart(2,'0')}` : null;
            const urls = (p.urls || []).map(u => u.value).filter(Boolean);
            if (!name && phones.length === 0 && emails.length === 0) continue;
            contacts.push({
                name,
                phones: phones.map(p => p.number),
                phoneDetails: phones,
                emails: emails.map(e => e.email),
                emailDetails: emails,
                org, title, note, birthday, urls,
                source: 'google-contacts',
            });
        }
        pageToken = res.nextPageToken || null;
    } while (pageToken);
    return contacts;
}

async function handleOAuthCallback(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
        res.writeHead(302, { Location: '/' }); res.end(); return;
    }

    const pending = pendingOAuth[state];
    if (!pending || Date.now() > pending.expiresAt) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('OAuth session expired or not found. Please try again from the app.'); return;
    }
    // CSRF: verify the state param matches the oauth_state cookie set at initiation.
    // Without this, an attacker could send their state to a victim to bind the
    // victim's Google account to the attacker's tenant.
    const cookieState = (req.headers.cookie || '').match(/oauth_state=([a-f0-9]+)/)?.[1];
    if (!cookieState || cookieState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('OAuth state mismatch. Please retry from the app.'); return;
    }
    delete pendingOAuth[state];
    const { uuid } = pending;
    // Clear the one-shot CSRF cookie
    res.setHeader('Set-Cookie', 'oauth_state=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');

    // Exchange code for tokens
    let tokens;
    try {
        tokens = await httpsPost('oauth2.googleapis.com', '/token',
            new URLSearchParams({
                client_id: userConfig.getGoogleClient(DATA).id,
                client_secret: userConfig.getGoogleClient(DATA).secret,
                code,
                redirect_uri: oauthCallbackUrl(req),
                grant_type: 'authorization_code',
            }).toString());
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Token exchange failed: ' + e.message); return;
    }

    if (tokens.error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Google error: ' + (tokens.error_description || tokens.error)); return;
    }

    // Get email address
    let emailAddr;
    try {
        const info = await httpsGet('www.googleapis.com', '/oauth2/v2/userinfo', tokens.access_token);
        emailAddr = info.email;
    } catch { emailAddr = null; }

    const meta = loadSourcesMeta();

    const dataDir = getUserDataDir(uuid);
    const uPaths = getUserPaths(uuid);
    const mergeOut = path.dirname(uPaths.contacts);

    if (pending.purpose === 'google-contacts') {
        // Store connection metadata
        meta.googleContacts = {
            status: 'connected',
            email: emailAddr,
            connectedAt: new Date().toISOString(),
        };
        saveSourcesMeta(meta);

        // Fetch contacts from People API and write to google-contacts dir
        try {
            const contacts = await fetchContactsFromPeopleAPI(tokens.access_token);
            const outDir = path.join(dataDir, 'google-contacts');
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'contacts.json'), JSON.stringify(contacts, null, 2));
            console.log(`Google Contacts OAuth: saved ${contacts.length} contacts`);
            fs.mkdirSync(mergeOut, { recursive: true });
            runMerge(dataDir, mergeOut);
            delete _interactionIndex[uuid];
            delete _searchIndex[uuid];
        } catch (e) {
            console.error('Google Contacts import error after OAuth:', e);
        }
    } else {
        // Gmail — store account
        meta.email = meta.email || {};
        const accounts = meta.email.accounts || [];
        const existing = accounts.findIndex(a => a.email === emailAddr);
        const entry = { email: emailAddr, provider: 'google',
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || accounts[existing]?.refreshToken,
            connectedAt: new Date().toISOString() };
        if (existing >= 0) accounts[existing] = entry; else accounts.push(entry);
        meta.email.accounts = accounts;
        meta.email.status = 'connected';
        meta.email.connectedAt = entry.connectedAt;
        saveSourcesMeta(meta);

        const outDir = path.join(dataDir, 'email');
        fs.mkdirSync(outDir, { recursive: true });
        try {
            runImporter('sources/email/import.js', {
                EMAIL_ACCESS_TOKEN: tokens.access_token,
                EMAIL_TOKEN_TYPE: 'google',
                EMAIL_LIMIT: '1000',
                EMAIL_OUT_DIR: outDir,
            });
            fs.mkdirSync(mergeOut, { recursive: true });
            runMerge(dataDir, mergeOut);
            delete _interactionIndex[uuid];
            delete _searchIndex[uuid];
        } catch (e) {
            console.error('Gmail import error after OAuth:', e);
        }
        // Also auto-fetch Google Contacts
        try {
            const contacts = await fetchContactsFromPeopleAPI(tokens.access_token);
            const gcOutDir = path.join(dataDir, 'google-contacts');
            fs.mkdirSync(gcOutDir, { recursive: true });
            fs.writeFileSync(path.join(gcOutDir, 'contacts.json'), JSON.stringify(contacts, null, 2));
            meta.googleContacts = { status: 'connected', syncedAt: new Date().toISOString(), count: contacts.length };
            saveSourcesMeta(meta);
            runMerge(dataDir, mergeOut);
            delete _interactionIndex[uuid];
            delete _searchIndex[uuid];
            console.log(`Auto-synced ${contacts.length} Google Contacts for ${emailAddr}`);
        } catch (e) {
            console.log('Google Contacts auto-sync skipped:', e.message);
        }
    }

    res.writeHead(302, { Location: '/' });
    res.end();
}

async function handleSyncGoogleContacts(req, res, params, paths, uuid) {
    const meta = loadSourcesMeta();

    const accounts = meta.email?.accounts || [];
    const googleAcc = accounts.find(a => a.provider === 'google' && a.refreshToken);
    if (!googleAcc) return json(res, { error: 'No connected Google account. Connect Gmail first.', needs_reauth: true }, 400);

    if (!userConfig.getGoogleClient(DATA).id) return json(res, { error: 'Google OAuth client ID not set — open Settings to configure' }, 400);

    // Refresh the access token
    let tokens;
    try {
        tokens = await httpsPost('oauth2.googleapis.com', '/token',
            new URLSearchParams({ client_id: userConfig.getGoogleClient(DATA).id,
                client_secret: userConfig.getGoogleClient(DATA).secret,
                refresh_token: googleAcc.refreshToken,
                grant_type: 'refresh_token' }).toString());
    } catch (e) {
        return json(res, { error: 'Token refresh failed: ' + e.message }, 500);
    }
    if (tokens.error) return json(res, { error: tokens.error_description || tokens.error, needs_reauth: true }, 400);

    // Fetch contacts from People API
    let contacts;
    try {
        contacts = await fetchContactsFromPeopleAPI(tokens.access_token);
    } catch (e) {
        if (e.message.includes('403') || e.message.toLowerCase().includes('scope') || e.message.includes('401')) {
            return json(res, { error: 'Contacts permission not granted. Re-connect Gmail to enable.', needs_reauth: true }, 403);
        }
        return json(res, { error: e.message }, 500);
    }

    const dataDir = getUserDataDir(uuid);
    const gcOutDir = path.join(dataDir, 'google-contacts');
    fs.mkdirSync(gcOutDir, { recursive: true });
    fs.writeFileSync(path.join(gcOutDir, 'contacts.json'), JSON.stringify(contacts, null, 2));

    meta.googleContacts = { status: 'connected', syncedAt: new Date().toISOString(), count: contacts.length };
    saveSourcesMeta(meta);

    const uPaths = getUserPaths(uuid);
    const mergeOut = path.dirname(uPaths.contacts);
    fs.mkdirSync(mergeOut, { recursive: true });
    runMerge(dataDir, mergeOut);
    delete _interactionIndex[uuid];
    delete _searchIndex[uuid];

    json(res, { ok: true, count: contacts.length });
}

async function handleRemoveEmailAccount(req, res, params, paths, uuid) {
    const { email } = await body(req);
    const meta = loadSourcesMeta();
    if (!meta.email?.accounts) return json(res, { ok: true });
    meta.email.accounts = meta.email.accounts.filter(a => a.email !== email);
    if (meta.email.accounts.length === 0) meta.email.status = 'not_connected';
    saveSourcesMeta(meta);
    json(res, { ok: true });
}

// WhatsApp session management (per user)
const waClients = {}; // uuid -> { client, qr, status }
const waSilentResume = new Set(); // uuids whose current init was auto-triggered (no UI watching)

async function handleWhatsappStart(req, res, params, paths, uuid) {
    const existing = waClients[uuid];
    if (existing) {
        const s = existing.status;
        // Anything except a terminal failure short-circuits — a second
        // client.initialize() against the same .wwebjs_auth would clash on
        // Puppeteer's userDataDir SingletonLock and crash the running session.
        if (s === 'ready') return json(res, { status: 'already_connected' });
        if (s === 'qr_pending') return json(res, { status: 'qr_pending' });
        if (s === 'initializing' || s === 'authenticated' || s === 'done') {
            return json(res, { status: s });
        }
        // s === 'auth_failure' or 'error': fall through and re-init.
    }

    let Client, LocalAuth;
    try {
        ({ Client, LocalAuth } = require('whatsapp-web.js'));
    } catch (e) {
        return json(res, { error: 'whatsapp-web.js not installed. Run: npm install whatsapp-web.js qrcode' }, 500);
    }

    const dataDir = getUserDataDir(uuid);
    const authDir = path.join(dataDir, '.wwebjs_auth');
    const waDir = path.join(dataDir, 'whatsapp');
    fs.mkdirSync(waDir, { recursive: true });

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: uuid, dataPath: authDir }),
        puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'], protocolTimeout: 600000 },
    });

    waClients[uuid] = { client, qr: null, status: 'initializing' };

    client.on('qr', qr => {
        let QRCode;
        try { QRCode = require('qrcode'); } catch (e) { return; }
        QRCode.toDataURL(qr, { width: 256 }, (err, url) => {
            if (!err) waClients[uuid].qr = url;
        });
        waClients[uuid].status = 'qr_pending';
        console.log(`WhatsApp QR ready for user ${uuid}`);
        // If we got here on a silent boot resume, the persisted session is
        // gone — surface a banner so the user knows to come back and rescan.
        if (waSilentResume.has(uuid)) {
            notifications.set(dataDir, 'whatsapp', {
                needsReauth: true,
                pauseSync: true,
                message: 'WhatsApp session expired — open Sources and rescan the QR.',
            });
            waSilentResume.delete(uuid);
        }
    });

    client.on('authenticated', () => {
        waClients[uuid].status = 'authenticated';
        notifications.dismiss(dataDir, 'whatsapp');
        waSilentResume.delete(uuid);
    });

    client.on('ready', async () => {
        waClients[uuid].status = 'ready';
        console.log(`WhatsApp ready for user ${uuid}, exporting...`);
        // Capture the user's own WhatsApp identity so the merger doesn't surface
        // them as a top contact (Note-to-Self chat is the usual culprit).
        try {
            const wid = client.info?.wid?._serialized || null;
            const pushname = client.info?.pushname || null;
            if (wid) {
                saveSelfIdentity(uuid, { whatsapp: { wid, pushname } });
                console.log(`[self] WhatsApp identity captured: ${pushname || '(no name)'} <${wid}>`);
            }
        } catch (e) {
            console.error('[self] WhatsApp identity capture failed:', e.message);
        }
        const mergeOut = paths.contacts ? path.dirname(paths.contacts) : path.join(dataDir, 'unified');
        fs.mkdirSync(mergeOut, { recursive: true });
        const runIncrementalMerge = () => {
            try {
                runMerge(dataDir, mergeOut);
                delete _interactionIndex[uuid];
                delete _searchIndex[uuid];
            } catch (e) { console.error('[whatsapp] incremental merge failed:', e.message); }
        };
        try {
            await exportWhatsapp(
                client,
                waDir,
                (progress) => { waClients[uuid].progress = progress; },
                { onChatDone: ({ index, total }) => {
                    if (index === 1 || index === total || index % 25 === 0) runIncrementalMerge();
                } },
            );
            runIncrementalMerge();
            updateUserSource(uuid, 'whatsapp', { status: 'connected', connectedAt: new Date().toISOString() });
            waClients[uuid].status = 'done';
            ensureSyncDaemon(uuid).attachWhatsApp(client);
        } catch (e) {
            console.error('WhatsApp export error:', e);
            waClients[uuid].status = 'error';
        }
    });

    client.on('auth_failure', () => {
        waClients[uuid].status = 'auth_failure';
        notifications.set(dataDir, 'whatsapp', {
            needsReauth: true,
            pauseSync: true,
            message: 'WhatsApp authentication failed — open Sources to reconnect.',
        });
        waSilentResume.delete(uuid);
    });

    client.initialize().catch(e => {
        console.error('WhatsApp init error:', e);
        waClients[uuid].status = 'error';
    });

    json(res, { status: 'starting' });
}

// Boot-time silent resume. If the user has a previously paired WhatsApp session
// on disk, re-initialize the client so the live message listener attaches and
// stale incremental data catches up. If the persisted session is invalid we
// surface a banner via notifications.set() and skip future resume attempts
// (handleWhatsappStart's qr/auth_failure handlers do that themselves).
function autoResumeWhatsapp(uuid) {
    if (waClients[uuid]) return; // already running or in QR flow
    const dataDir = getUserDataDir(uuid);
    if (notifications.isPaused(dataDir, 'whatsapp')) return; // user hasn't reconnected yet
    const authDir = path.join(dataDir, '.wwebjs_auth');
    if (!fs.existsSync(authDir)) return; // user never connected — nothing to resume
    const paths = getUserPaths(uuid);
    waSilentResume.add(uuid);
    const fakeRes = { writeHead: () => {}, end: () => {} };
    handleWhatsappStart({}, fakeRes, [], paths, uuid)
        .catch(e => {
            waSilentResume.delete(uuid);
            console.error('[autosync] WhatsApp auto-resume failed:', e.message);
        });
}

function handleListNotifications(req, res, params, paths, uuid) {
    json(res, { notifications: notifications.list(getUserDataDir(uuid)) });
}

// POST /api/self/whatsapp — pulls the user's own wid/pushname from the
// currently-connected wweb.js client. Useful when 'ready' already fired
// before identity-capture shipped (so saveSelfIdentity didn't run).
function handleCaptureSelfWhatsapp(req, res, params, paths, uuid) {
    const session = waClients[uuid];
    if (!session || !session.client || session.status !== 'ready') {
        return json(res, { error: 'WhatsApp not connected (status=' + (session?.status || 'none') + ')' }, 400);
    }
    const wid = session.client.info?.wid?._serialized || null;
    const pushname = session.client.info?.pushname || null;
    if (!wid) return json(res, { error: 'client.info.wid not yet available — try again in a moment' }, 503);
    saveSelfIdentity(uuid, { whatsapp: { wid, pushname } });
    json(res, { ok: true, wid, pushname, identity: loadSelfIdentity(uuid) });
}

function handleGetSelfIdentity(req, res, params, paths, uuid) {
    json(res, { identity: loadSelfIdentity(uuid) });
}

function handleDismissNotification(req, res, [source], paths, uuid) {
    notifications.dismiss(getUserDataDir(uuid), source);
    json(res, { ok: true });
}

function handleWhatsappProfilePic(req, res, [encodedId], paths, uuid) {
    // Serve cached profile pic from data/whatsapp/profile_pics/. Pre-sanitized filenames
    // match the runWhatsAppExport writer: `${id.replace(/[^a-z0-9@._-]/gi, '_')}.jpg`.
    try {
        const safe = decodeURIComponent(encodedId).replace(/[^a-z0-9@._-]/gi, '_');
        const dataDir = getUserDataDir(uuid);
        const picPath = path.join(dataDir, 'whatsapp', 'profile_pics', `${safe}.jpg`);
        // Guard path traversal — ensure resolved path stays inside picsDir.
        const picsDir = path.join(dataDir, 'whatsapp', 'profile_pics');
        if (!picPath.startsWith(picsDir + path.sep)) {
            return json(res, { error: 'forbidden' }, 403);
        }
        if (!fs.existsSync(picPath)) {
            return json(res, { error: 'not found' }, 404);
        }
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'private, max-age=86400',
        });
        fs.createReadStream(picPath).pipe(res);
    } catch (e) {
        json(res, { error: e.message }, 500);
    }
}

function readExportProgress(uuid) {
    try {
        const dataDir = getUserDataDir(uuid);
        const progressPath = path.join(dataDir, 'whatsapp', '.export-progress.json');
        if (!fs.existsSync(progressPath)) return null;
        return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    } catch { return null; }
}

function handleWhatsappStatus(req, res, params, paths, uuid) {
    const session = waClients[uuid];
    if (!session) {
        const dataDir = getUserDataDir(uuid);
        const hasData = fs.existsSync(path.join(dataDir, 'whatsapp', 'contacts.json'));
        return json(res, { status: hasData ? 'done' : 'not_started', progress: readExportProgress(uuid) });
    }
    json(res, {
        status: session.status,
        qr: session.status === 'qr_pending' ? session.qr : null,
        progress: session.progress || readExportProgress(uuid) || null,
    });
}

function handleWhatsappProgress(req, res, params, paths, uuid) {
    const session = waClients[uuid];
    const progress = session?.progress || readExportProgress(uuid);
    const live = !!session;
    const active = !!progress
        && progress.step !== 'done'
        && progress.step !== 'error'
        && (live || !sourceProgress.isStale(progress));
    json(res, { active, progress: progress || null });
}

/**
 * Generic per-source progress endpoint: /api/sources/<key>/progress.
 * For `whatsapp`, preserves the live in-memory session progress so the toast
 * updates in real time during the current import.
 */
function handleSourceProgress(req, res, params, paths, uuid) {
    const key = params[0];
    if (!sourceProgress.SOURCE_DIR[key]) {
        res.writeHead(404); res.end('unknown source'); return;
    }
    const dataDir = getUserDataDir(uuid);
    let progress = sourceProgress.readProgress(dataDir, key);
    if (key === 'whatsapp') {
        // Prefer live in-memory progress when a session is running
        const session = waClients[uuid];
        if (session && session.progress) progress = session.progress;
    }
    const active = sourceProgress.isActive(progress);
    json(res, { active, progress: progress || null, percent: sourceProgress.percent(progress) });
}

/**
 * Global sync progress: every source with any progress record, keyed by source.
 * The UI uses this to drive a rolling toast: "Importing LinkedIn — 2/4" etc.
 */
function handleSyncProgress(req, res, params, paths, uuid) {
    const dataDir = getUserDataDir(uuid);
    const all = sourceProgress.listProgress(dataDir);
    // Overlay live WhatsApp session progress
    const session = waClients[uuid];
    if (session && session.progress) {
        all.whatsapp = { ...(all.whatsapp || {}), source: 'whatsapp', ...session.progress };
    }
    const active = {};
    for (const [k, v] of Object.entries(all)) {
        if (sourceProgress.isActive(v)) active[k] = { ...v, percent: sourceProgress.percent(v) };
    }
    json(res, { active, all });
}

async function exportWhatsapp(client, waDir, onProgress = () => {}, opts = {}) {
    const chatsPath = path.join(waDir, 'chats.json');
    const progressPath = path.join(waDir, '.export-progress.json');
    const writeProgress = (p) => {
        onProgress(p);
        try { fs.writeFileSync(progressPath, JSON.stringify({ ...p, updatedAt: new Date().toISOString() })); } catch {}
    };

    writeProgress({ step: 'contacts', message: 'Loading contacts...' });
    const contacts = await client.getContacts();
    const contactMap = {};
    for (const c of contacts) {
        contactMap[c.id._serialized] = {
            name: c.name || c.pushname || c.shortName || null,
            number: c.number,
            isMyContact: c.isMyContact,
            isBusiness: c.isBusiness,
            about: c.about || null,
        };
    }
    fs.writeFileSync(path.join(waDir, 'contacts.json'), JSON.stringify(contactMap, null, 2));

    // -------------------------------------------------------------------
    // Enrichment pass: about text + profile pics for saved contacts.
    // Runs in parallel batches; tolerates individual failures.
    // -------------------------------------------------------------------
    const savedContacts = contacts.filter(c => c.isMyContact);
    const picDir = path.join(waDir, 'profile_pics');
    try { fs.mkdirSync(picDir, { recursive: true }); } catch {}

    writeProgress({
        step: 'enrich',
        current: 0,
        total: savedContacts.length,
        message: `Fetching about + profile pics for ${savedContacts.length} saved contacts...`,
    });

    const BATCH = 20;
    for (let i = 0; i < savedContacts.length; i += BATCH) {
        const slice = savedContacts.slice(i, i + BATCH);
        const ids = slice.map(c => c.id._serialized);

        // About text — one call per contact (library wraps Store.StatusUtils.getStatus).
        const aboutResults = await Promise.all(
            slice.map(c => c.getAbout().catch(() => null))
        );

        // Profile pic URLs — one page-evaluate batched call.
        let picUrlMap = {};
        try {
            picUrlMap = await client.pupPage.evaluate(async (batchIds) => {
                const out = {};
                await Promise.all(batchIds.map(async (wid) => {
                    try {
                        const chatWid = window.Store.WidFactory.createWid(wid);
                        const result = await window.Store.ProfilePicThumb.findImpl(chatWid, true);
                        out[wid] = (result && result.attributes && result.attributes.eurl) || null;
                    } catch { out[wid] = null; }
                }));
                return out;
            }, ids);
        } catch (e) {
            console.error('[whatsapp] profile-pic batch failed:', e.message);
        }

        // Download pics that exist; store local path on contactMap
        await Promise.all(slice.map(async (c, j) => {
            const id = ids[j];
            const about = aboutResults[j];
            if (about) contactMap[id].about = about;

            const picUrl = picUrlMap[id];
            if (picUrl) {
                const safe = id.replace(/[^a-z0-9@._-]/gi, '_');
                const picFile = path.join(picDir, `${safe}.jpg`);
                try {
                    await new Promise((resolve) => {
                        const proto = picUrl.startsWith('https') ? require('https') : require('http');
                        const file = fs.createWriteStream(picFile);
                        proto.get(picUrl, res => {
                            res.pipe(file);
                            file.on('finish', () => { file.close(); resolve(); });
                            file.on('error', () => resolve());
                        }).on('error', () => resolve());
                    });
                    contactMap[id].profilePic = path.relative(waDir, picFile);
                } catch { /* pic fetch failed, skip silently */ }
            }
        }));

        writeProgress({
            step: 'enrich',
            current: Math.min(i + BATCH, savedContacts.length),
            total: savedContacts.length,
            message: `Enriched ${Math.min(i + BATCH, savedContacts.length)}/${savedContacts.length}`,
        });
    }
    fs.writeFileSync(path.join(waDir, 'contacts.json'), JSON.stringify(contactMap, null, 2));

    writeProgress({ step: 'chats', message: 'Loading chat list...' });
    const chats = await client.getChats();
    const total = chats.length;

    let result = {};
    const existingIds = {};
    let resuming = false;
    if (fs.existsSync(chatsPath)) {
        try {
            result = JSON.parse(fs.readFileSync(chatsPath, 'utf8')) || {};
            resuming = Object.keys(result).length > 0;
            for (const [name, chat] of Object.entries(result)) {
                existingIds[name] = new Set((chat.messages || []).map(m => m.id));
            }
        } catch { result = {}; }
    }

    const firstRun = !resuming;
    // Pull every locally-available message per chat. WhatsApp Web's IndexedDB
    // is the real ceiling — we just stop capping below that.
    const limit = opts.limit ?? Infinity;
    let msgCount = Object.values(result).reduce((n, c) => n + (c.messages?.length || 0), 0);

    for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const name = chat.name || chat.id?._serialized || `chat-${i}`;
        writeProgress({
            step: 'messages',
            current: i + 1,
            total,
            messageCount: msgCount,
            firstRun,
            chatName: name,
            message: `Syncing ${i + 1}/${total}: ${name}`,
        });

        // Capture metadata FIRST — independent of fetchMessages success.
        // `chat.participants`, `chat.groupMetadata`, etc. are hydrated by
        // `client.getChats()` itself (Utils.js:645-654), not by fetchMessages.
        // Keeping these even when the message fetch throws is valuable signal.
        const meta = {
            id: chat.id._serialized,
            name: chat.name || null,
            isGroup: chat.isGroup,
            isReadOnly: chat.isReadOnly || false,
            unreadCount: chat.unreadCount || 0,
            lastMessageTime: chat.lastMessage?.timestamp
                ? new Date(chat.lastMessage.timestamp * 1000).toISOString()
                : null,
        };
        if (chat.isGroup) {
            meta.participants = (chat.participants || [])
                .map(p => ({
                    id: p.id?._serialized,
                    isAdmin: !!p.isAdmin,
                    isSuperAdmin: !!p.isSuperAdmin,
                }))
                .filter(p => p.id);
            meta.participantCountAtSync = meta.participants.length;
            meta.owner = chat.owner?._serialized || null;
            meta.createdAt = chat.createdAt?.toISOString?.() || null;
            meta.description = chat.description || null;
        }

        // WhatsApp Business labels per chat — no-op / throws on personal accounts.
        try {
            const labels = await chat.getLabels();
            if (labels && labels.length > 0) {
                meta.labels = labels.map(l => ({ id: l.id, name: l.name, hexColor: l.hexColor }));
            }
        } catch { /* personal account — ignore */ }

        // Pinned messages — user-curated "important" signal. Works on any chat.
        try {
            const pinned = await client.getPinnedMessages(chat.id._serialized);
            if (pinned && pinned.length > 0) {
                meta.pinnedMessages = pinned.map(m => ({
                    id: m.id?._serialized || null,
                    timestamp: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
                    from: m.from || null,
                    body: m.body || '',
                    type: m.type || 'chat',
                }));
            }
        } catch { /* not all chats support pinned / upstream may fail */ }

        // Attempt message fetch; tolerate failure (known wweb.js waitForChatLoading issue).
        let newMessages = [];
        try {
            const fetched = await chat.fetchMessages({ limit });
            const seen = existingIds[name] || new Set();
            newMessages = fetched
                .filter(m => !seen.has(m.id._serialized))
                .map(m => ({
                    id: m.id._serialized,
                    timestamp: new Date(m.timestamp * 1000).toISOString(),
                    from: m.from, body: m.body, type: m.type,
                }));
        } catch (e) {
            console.error(`[whatsapp] fetchMessages failed for ${name}:`, e.message);
            // fall through — meta is still written
        }

        const existing = result[name];
        result[name] = {
            meta,
            messages: existing ? [...(existing.messages || []), ...newMessages] : newMessages,
        };
        msgCount += newMessages.length;

        fs.writeFileSync(chatsPath, JSON.stringify(result, null, 2));

        if (opts.onChatDone) {
            try { await opts.onChatDone({ index: i + 1, total, messageCount: msgCount }); } catch {}
        }
    }

    writeProgress({ step: 'done', current: total, total, messageCount: msgCount, message: `Imported ${msgCount.toLocaleString()} messages` });
    try { fs.unlinkSync(progressPath); } catch {}
    // NOTE: don't destroy() here — the caller attaches a live message
    // listener to this same client after export completes. Destroying
    // breaks the listener and "Live — receiving messages" becomes a lie.
}

// ---------------------------------------------------------------------------
// Route table  [method, regex, handler]
// Params captured by regex groups are passed as decoded strings to handler.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sync daemon — one instance per user
// ---------------------------------------------------------------------------

const { startSyncDaemon, triggerSync } = require('./sync');
const { rankContactsForGoal } = require('./utils');
const { buildReconnectTemplate, regenerateDraft } = require('./reconnect');
const syncDaemons = {}; // uuid -> daemon instance

function ensureSyncDaemon(uuid) {
    if (!syncDaemons[uuid]) {
        const userDataDir = getUserDataDir(uuid);
        syncDaemons[uuid] = startSyncDaemon(uuid, userDataDir);
    }
    return syncDaemons[uuid];
}

function handleGetSyncStatus(req, res, params, paths, uuid) {
    const daemon = ensureSyncDaemon(uuid);
    json(res, daemon.getState());
}

async function handleTriggerSync(req, res, [source], paths, uuid) {
    const validSources = ['email', 'googleContacts', 'linkedin', 'telegram', 'sms', 'whatsapp'];
    if (!validSources.includes(source)) {
        return json(res, { error: 'Unknown source: ' + source }, 400);
    }
    try {
        const result = await triggerSync(uuid, source, getUserDataDir(uuid));
        json(res, result);
    } catch (e) {
        json(res, { ok: false, message: e.message }, 500);
    }
}

function handleGetStaleness(req, res, params, paths, uuid) {
    const daemon = ensureSyncDaemon(uuid);
    const syncState = daemon.getState();
    const summary = getDataHealthSummary(syncState);
    json(res, {
        level:        summary.level,
        warnings:     summary.warnings,
        staleSources: summary.staleSources,
    });
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

// Default pipeline every new goal starts with. Users can customise per-goal.
const DEFAULT_GOAL_STAGES = ['To reach out', 'Contacted', 'Meeting', 'Intro made', 'Closed'];

function loadGoals(paths) {
    try {
        const goals = JSON.parse(fs.readFileSync(paths.goals, 'utf8'));
        // Back-fill pipeline fields so existing goals continue to work.
        return goals.map(g => ({
            stages:      Array.isArray(g.stages) && g.stages.length ? g.stages : DEFAULT_GOAL_STAGES.slice(),
            assignments: (g.assignments && typeof g.assignments === 'object') ? g.assignments : {},
            ...g,
        }));
    }
    catch { return []; }
}

function handleGetGoals(req, res, params, paths) {
    json(res, loadGoals(paths));
}

async function handleSaveGoals(req, res, params, paths) {
    const data = await body(req);
    // data may be a single goal object (upsert) or a full array replacement
    let goals;
    if (Array.isArray(data)) {
        goals = data;
    } else if (data && typeof data === 'object') {
        // Upsert: merge into existing goals
        const existing = loadGoals(paths);
        if (data.id) {
            const idx = existing.findIndex(g => g.id === data.id);
            if (idx >= 0) { existing[idx] = { ...existing[idx], ...data }; goals = existing; }
            else { goals = [...existing, data]; }
        } else {
            // New goal — assign id
            const id = 'g_' + Date.now().toString(36);
            goals = [...existing, {
                id,
                createdAt: new Date().toISOString(),
                active: true,
                stages: DEFAULT_GOAL_STAGES.slice(),
                assignments: {},
                ...data,
            }];
        }
    } else {
        return json(res, { error: 'invalid body' }, 400);
    }
    fs.writeFileSync(paths.goals, JSON.stringify(goals, null, 2));
    json(res, goals);
}

/**
 * POST /api/goals/:id/assign  { contactId, stage }
 * Move a contact to a stage within a goal's pipeline. `stage` is either the
 * stage label (case-insensitive) or its 0-based index. Pass stage=null to
 * remove the contact from the pipeline.
 */
async function handleGoalAssign(req, res, [goalId], paths) {
    const body_ = await body(req);
    const contactId = body_ && body_.contactId;
    if (!contactId) return json(res, { error: 'contactId required' }, 400);

    const goals = loadGoals(paths);
    const goal = goals.find(g => g.id === goalId);
    if (!goal) return json(res, { error: 'goal not found' }, 404);

    const stages = goal.stages || DEFAULT_GOAL_STAGES;
    const assignments = goal.assignments || {};

    let stage = body_.stage;
    if (stage === null || stage === undefined || stage === '') {
        delete assignments[contactId];
    } else {
        let stageLabel;
        if (typeof stage === 'number') {
            if (stage < 0 || stage >= stages.length) return json(res, { error: 'stage out of range' }, 400);
            stageLabel = stages[stage];
        } else {
            stageLabel = stages.find(s => s.toLowerCase() === String(stage).toLowerCase());
            if (!stageLabel) return json(res, { error: 'unknown stage ' + stage }, 400);
        }
        assignments[contactId] = {
            stage: stageLabel,
            updatedAt: new Date().toISOString(),
        };
    }

    goal.assignments = assignments;
    goal.updatedAt = new Date().toISOString();
    fs.writeFileSync(paths.goals, JSON.stringify(goals, null, 2));
    json(res, { goal });
}

/**
 * GET /api/goals/:id/pipeline
 * Returns the pipeline of assigned contacts per stage, hydrated with
 * summary contact data (name, company, score, days-since-contact).
 */
function handleGoalPipeline(req, res, [goalId], paths) {
    const goals = loadGoals(paths);
    const goal = goals.find(g => g.id === goalId);
    if (!goal) return json(res, { error: 'goal not found' }, 404);

    const stages = goal.stages || DEFAULT_GOAL_STAGES;
    const contacts = loadContacts(paths);
    const byId = Object.fromEntries(contacts.map(c => [c.id, c]));

    const pipeline = stages.map(s => ({ stage: s, contacts: [] }));
    const assignments = goal.assignments || {};
    for (const [cid, ass] of Object.entries(assignments)) {
        const c = byId[cid];
        if (!c) continue;
        const stageLabel = (ass && ass.stage) || (typeof ass === 'string' ? ass : null);
        const stageIdx = stages.findIndex(s => s.toLowerCase() === String(stageLabel || '').toLowerCase());
        if (stageIdx < 0) continue;
        pipeline[stageIdx].contacts.push({
            id: c.id, name: c.name,
            company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
            position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
            relationshipScore: c.relationshipScore || 0,
            daysSinceContact: c.daysSinceContact ?? null,
            updatedAt: ass && ass.updatedAt,
        });
    }
    json(res, { goalId, text: goal.text, stages, pipeline });
}

// GET /api/today — goal-relevant contacts, network pulse, upcoming meetings
function handleGetToday(req, res, params, paths, uuid) {
    const goals = loadGoals(paths);
    const contacts = loadContacts(paths);
    const insights = loadInsights(paths);

    // Load calendar meetings from sync-state.json
    const syncStatePath = path.join(path.dirname(paths.contacts), '..', 'sync-state.json');
    let upcomingMeetings = [];
    try {
        const syncState = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
        const rawMeetings = syncState.calendar?.upcomingMeetings || [];
        // Re-enrich with current contact data and filter to today+tomorrow
        const { buildEmailIndex, enrichAttendees, isMeetingToday, sortMeetings } = require('./calendar');
        const emailIndex = buildEmailIndex(contacts);
        const today = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        upcomingMeetings = sortMeetings(rawMeetings
            .filter(m => m.startAt && (m.startAt.slice(0, 10) === today || m.startAt.slice(0, 10) === tomorrow))
            .map(m => ({
                ...m,
                attendees: enrichAttendees(m.attendees || [], emailIndex, insights),
            }))
        );
    } catch { /* no calendar data yet — graceful degradation */ }

    const activeGoals = goals.filter(g => g.active !== false);

    // For each active goal, compute top relevant contacts (scored by relevance × warmth)
    const goalSections = activeGoals.map(goal => {
        const ranked = rankContactsForGoal(contacts, goal.text, 5);
        return {
            goalId:   goal.id,
            goalText: goal.text,
            contacts: ranked.map(c => {
                const company  = c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null;
                const position = c.sources?.linkedin?.position || c.sources?.googleContacts?.title || c.apollo?.title || null;
                const ins = insights[c.id] || null;
                return {
                    id:                c.id,
                    name:              c.name,
                    company,
                    position,
                    relationshipScore: c.relationshipScore || 0,
                    daysSinceContact:  c.daysSinceContact  || null,
                    activeChannels:    c.activeChannels    || [],
                    goalRelevance:     c.goalRelevance,
                    meetingBrief:      ins ? ins.meetingBrief : null,
                    topics:            ins ? (ins.topics || []) : [],
                };
            }),
        };
    });

    // Network pulse: notable contacts across all goals with signals
    // Surface top contacts by combined score who haven't been in any goal section
    const usedIds = new Set(goalSections.flatMap(s => s.contacts.map(c => c.id)));
    const pulse = contacts
        .filter(c => c.name && !c.isGroup && !usedIds.has(c.id) && (c.relationshipScore || 0) >= 50)
        .sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0))
        .slice(0, 3)
        .map(c => ({
            id:                c.id,
            name:              c.name,
            company:           c.sources?.linkedin?.company || null,
            position:          c.sources?.linkedin?.position || null,
            relationshipScore: c.relationshipScore || 0,
            daysSinceContact:  c.daysSinceContact  || null,
        }));

    // Sync warnings for primary sources
    let syncWarnings = [];
    try {
        const daemon = ensureSyncDaemon(uuid);
        const syncState = daemon.getState();
        const health = getDataHealthSummary(syncState);
        syncWarnings = health.warnings;
    } catch { /* graceful degradation */ }

    // Life events (top 6) — surfaced on the Today view's "Recent in your
    // network" section. Cheap to compute; done inline here to keep the
    // Today view a single-request render.
    let lifeEvents = [];
    try {
        const ixns = fs.existsSync(paths.interactions)
            ? JSON.parse(fs.readFileSync(paths.interactions, 'utf8')) : [];
        const { contactMap } = buildSearchIndex(paths, uuid);
        const byContact = {};
        for (const i of ixns) {
            let cid = null;
            if (i.chatId) cid = contactMap[i.chatId];
            if (!cid && typeof i.from === 'string') cid = contactMap[i.from];
            if (!cid && i.source === 'linkedin' && i.chatName) {
                for (const name of i.chatName.split(',').map(n => n.trim())) {
                    if (contactMap[name]) { cid = contactMap[name]; break; }
                }
            }
            if (!cid) continue;
            if (!byContact[cid]) byContact[cid] = [];
            byContact[cid].push(i);
        }
        const contacts = loadContacts(paths);
        const contactById = Object.fromEntries(contacts.map(c => [c.id, c]));
        const all = _lifeEvents.detectAllEvents({ contacts, interactionsByContactId: byContact });
        for (const e of all) {
            const c = contactById[e.contactId];
            if (c) {
                e.company = c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null;
                e.position = c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null;
            }
        }
        lifeEvents = all.slice(0, 6);
    } catch (e) {
        console.error('[today/life-events]', e.message);
    }

    json(res, {
        goals:            activeGoals,
        goalSections,
        pulse,
        upcomingMeetings,
        syncWarnings,
        lifeEvents,
        generatedAt:      new Date().toISOString(),
    });
}

// GET /api/calendar/upcoming — next 7 days of meetings, enriched with contact data
function handleGetCalendarUpcoming(req, res, params, paths, uuid) {
    const { syncCalendarForAccount } = require('./sync');
    const syncStatePath = path.join(path.dirname(paths.contacts), '..', 'sync-state.json');
    let syncState = {};
    try { syncState = JSON.parse(fs.readFileSync(syncStatePath, 'utf8')); } catch { syncState = {}; }

    const calState = syncState.calendar || {};
    const meetings = calState.upcomingMeetings || [];

    // Re-enrich with current contact data (scores may have changed since last sync)
    const contacts = loadContacts(paths);
    const insights = loadInsights(paths);
    const { buildEmailIndex, enrichAttendees, sortMeetings } = require('./calendar');
    const emailIndex = buildEmailIndex(contacts);

    const enriched = meetings.map(m => ({
        ...m,
        attendees: enrichAttendees(m.attendees || [], emailIndex, insights),
    }));

    json(res, {
        meetings:    sortMeetings(enriched),
        lastSyncAt:  calState.lastSyncAt || null,
        status:      calState.status || 'idle',
    });
}

// ---------------------------------------------------------------------------
// Network query (TASK-028)
// ---------------------------------------------------------------------------
const { parseQuery: parseNetworkQuery, filterIndex, describeQuery } = require('./network-query');
const { getDataHealthSummary } = require('./staleness');

// Load query index (returns [] if not yet built)
function loadQueryIndex(paths) {
    try { return JSON.parse(fs.readFileSync(paths.queryIndex, 'utf8')); }
    catch { return []; }
}

// POST /api/network/query — instant Layer 2 results
// POST /api/network/query?enhance=true — runs Claude re-ranking (Layer 3, ~10s)
const { annotateResults: annotateQueryResults, expandQuery: expandQueryTerms } = require('./query-reasons');

async function handleNetworkQuery(req, res, _params, paths) {
    let reqBody;
    try { reqBody = await body(req); } catch { reqBody = {}; }
    const query = ((reqBody && reqBody.query) || '').trim();
    if (!query) { json(res, { error: 'query required' }, 400); return; }

    const index   = loadQueryIndex(paths);
    const parsedQ = parseNetworkQuery(query);
    let candidates = filterIndex(index, parsedQ);
    const description = describeQuery(parsedQ);

    // Semantic expansion: if the structured filter returned no results AND the
    // query has free-text terms with known expansions, fall back to a broader
    // match over Apollo/LinkedIn/insights text. This is what makes queries like
    // "anyone who works on notification systems" actually find people, instead
    // of returning empty because 'notification' isn't a role keyword.
    const { expandedTerms } = expandQueryTerms(parsedQ);
    if (candidates.length < 3 && expandedTerms.length) {
        const contactsById = Object.fromEntries(loadContacts(paths).map(c => [c.id, c]));
        const matched = [];
        for (const entry of index) {
            if (candidates.some(c => c.id === entry.id)) continue;
            const c = contactsById[entry.id];
            const text = (
                (entry.title || '') + ' ' +
                (entry.company || '') + ' ' +
                (c?.apollo?.headline || '') + ' ' +
                (c?.apollo?.industry || '') + ' ' +
                (c?.sources?.linkedin?.position || '') + ' ' +
                (c?.sources?.linkedin?.company || '')
            ).toLowerCase();
            if (expandedTerms.some(t => t.length > 2 && text.includes(t))) {
                matched.push(entry);
            }
        }
        // Append the semantic matches after structured matches
        candidates = candidates.concat(matched.slice(0, 20 - candidates.length));
    }

    // Group-path signal: candidates tied into the user's WhatsApp social graph
    // (many small group co-memberships) get a tie-breaking boost. The base
    // filterIndex ranking is preserved; the boost only shifts candidates within
    // a similar-score band. Helps when LinkedIn/email data is thin but someone
    // is clearly in your inner circle via WhatsApp communities.
    const memberships = loadGroupMemberships();
    const fullContacts = loadContacts(paths);
    const groupSignal = computeGroupSignalScores(fullContacts, memberships);
    const contactsById = Object.fromEntries(fullContacts.map(c => [c.id, c]));

    let insightsByContactId = {};
    try {
        const ins = JSON.parse(fs.readFileSync(paths.insights, 'utf8'));
        insightsByContactId = ins || {};
    } catch { /* missing insights.json is fine */ }

    // Re-rank within the shortlist by adding (groupSignal * 3) to the intent-based
    // sort key. Keeping the multiplier small preserves the dominant role/location
    // signals but lets group-path break ties and bubble up tightly-connected people.
    const baseIntentScore = (c) => {
        switch (parsedQ.intent) {
            case 'meet':      return c.meetScore || 0;
            case 'reconnect': return c.daysSinceContact || 0;
            case 'intro':     return (c.seniority_rank || 1) * 20;
            default:          return c.relationshipScore || 0;
        }
    };
    candidates = [...candidates].sort((a, b) => {
        const locBoostA = (parsedQ.locations?.length && parsedQ.locations.some(l => a.city === l)) ? 1000 : 0;
        const locBoostB = (parsedQ.locations?.length && parsedQ.locations.some(l => b.city === l)) ? 1000 : 0;
        const gA = (groupSignal[a.id] || 0) * 3;
        const gB = (groupSignal[b.id] || 0) * 3;
        return (locBoostB + baseIntentScore(b) + gB) - (locBoostA + baseIntentScore(a) + gA);
    });

    // Instant result shape (Layer 2 only)
    const instant = candidates.slice(0, 20).map(c => ({
        id:                c.id,
        name:              c.name,
        company:           c.company,
        title:             c.title,
        city:              c.city,
        roles:             c.roles,
        seniority:         c.seniority,
        relationshipScore: c.relationshipScore,
        daysSinceContact:  c.daysSinceContact,
        meetScore:         c.meetScore,
        groupSignal:       groupSignal[c.id] || 0,
        reason:            null,
    }));

    // Annotate with reasons ("Show thinking") — purely additive, doesn't change ranking.
    const annotated = annotateQueryResults(parsedQ, instant, {
        contactsById, insightsByContactId,
    });

    json(res, {
        query,
        parsed: parsedQ,
        description,
        expandedTerms,
        results: annotated,
        enhanced: false,
        processingMs: 0,
    });
}

// ── LinkedIn auto-sync (opt-in, experimental) ──────────────────────────────
// Gated behind MINTY_LINKEDIN_AUTOSYNC=1 env flag. All three endpoints return
// 404 when the flag is unset — this is the feature's kill-switch. POST endpoints
// also enforce Origin/Sec-Fetch-Site (via sources/linkedin/origin-check.js) to
// prevent a drive-by webpage from spawning a Chromium process on the user's machine.

// Now a runtime check (was a const) so the Settings UI toggle takes effect
// without a server restart. Routes registered below still ignore POSTs when
// the flag is off — see linkedinAutosyncEnabled() at each handler entry.
function linkedinAutosyncEnabled() { return userConfig.isLinkedInAutosyncEnabled(DATA); }

function readLinkedInState() {
    try {
        const state = JSON.parse(fs.readFileSync(path.join(DATA, 'sync-state.json'), 'utf8'));
        return state.linkedin || { status: 'disconnected' };
    } catch { return { status: 'disconnected' }; }
}

function linkedInPlaywrightAvailable() {
    try { require.resolve('playwright'); return true; } catch { return false; }
}

function linkedInGate(req, res) {
    if (!linkedinAutosyncEnabled()) { res.writeHead(404); res.end('not found'); return false; }
    if (req.method === 'POST') {
        let originCheck;
        try {
            const { requireSameOrigin } = require('../sources/linkedin/origin-check.js');
            originCheck = requireSameOrigin(req);
        } catch { res.writeHead(500); res.end('origin check unavailable'); return false; }
        if (!originCheck.ok) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'csrf', reason: originCheck.reason })); return false;
        }
    }
    return true;
}

const _linkedinChildren = new Map();

function handleLinkedInStatus(req, res) {
    if (!linkedInGate(req, res)) return;
    const state = readLinkedInState();
    json(res, { ...state, playwrightAvailable: linkedInPlaywrightAvailable() });
}

function handleLinkedInConnect(req, res) {
    if (!linkedInGate(req, res)) return;
    if (!linkedInPlaywrightAvailable()) {
        json(res, { error: 'playwright-missing', message: 'Run: npm run linkedin:setup' }, 503); return;
    }
    const state = readLinkedInState();
    if (state.status === 'syncing') { json(res, { error: 'sync in progress' }, 409); return; }
    const { spawn } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../sources/linkedin/connect.js');
    const child = spawn(process.execPath, [scriptPath], {
        detached: false, stdio: 'ignore', env: { ...process.env },
    });
    child.unref();
    _linkedinChildren.set(child.pid, child);
    child.on('exit', () => _linkedinChildren.delete(child.pid));
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: child.pid, message: 'Check your terminal / desktop for the Chromium window.' }));
}

function handleLinkedInSync(req, res) {
    if (!linkedInGate(req, res)) return;
    if (!linkedInPlaywrightAvailable()) {
        json(res, { error: 'playwright-missing', message: 'Run: npm run linkedin:setup' }, 503); return;
    }
    const state = readLinkedInState();
    if (state.status === 'syncing') { json(res, { error: 'sync in progress' }, 409); return; }
    if (state.status === 'disconnected') {
        json(res, { error: 'not connected', message: 'Run: npm run linkedin:connect (or click Enable auto-sync)' }, 400); return;
    }
    const { spawn } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../sources/linkedin/fetch.js');
    const child = spawn(process.execPath, [scriptPath], {
        detached: false, stdio: 'ignore', env: { ...process.env },
    });
    child.unref();
    _linkedinChildren.set(child.pid, child);
    child.on('exit', () => _linkedinChildren.delete(child.pid));
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: child.pid }));
}

const ROUTES = [
    ['GET',  /^\/api\/sources$/,                          handleGetSources],
    ['GET',  /^\/api\/linkedin\/status$/,                 handleLinkedInStatus],
    ['POST', /^\/api\/linkedin\/connect$/,                handleLinkedInConnect],
    ['POST', /^\/api\/linkedin\/sync$/,                   handleLinkedInSync],
    ['POST', /^\/api\/sources\/upload\/([^/]+)$/,         handleUploadSource],
    ['POST', /^\/api\/sources\/email$/,                   handleConnectEmail],
    ['POST', /^\/api\/sources\/email\/device-start$/,     handleEmailDeviceStart],
    ['GET',  /^\/api\/sources\/email\/device-poll$/,      handleEmailDevicePoll],
    ['POST', /^\/api\/sources\/email\/remove$/,           handleRemoveEmailAccount],
    ['POST', /^\/api\/sources\/google-contacts\/oauth-start$/, handleGoogleContactsOAuthStart],
    ['POST', /^\/api\/sources\/google-contacts\/sync$/,       handleSyncGoogleContacts],
    ['POST', /^\/api\/sources\/whatsapp\/start$/,         handleWhatsappStart],
    ['GET',  /^\/api\/sources\/whatsapp\/status$/,        handleWhatsappStatus],
    ['GET',  /^\/api\/sources\/whatsapp\/progress$/,      handleWhatsappProgress],
    ['GET',  /^\/api\/sources\/([a-zA-Z]+)\/progress$/,  handleSourceProgress],
    ['GET',  /^\/api\/sync\/progress$/,                   handleSyncProgress],
    ['GET',  /^\/api\/palette$/,                          handlePaletteSearch],
    ['GET',  /^\/api\/export$/,                           handleExport],
    ['GET',  /^\/api\/life-events$/,                      handleGetLifeEvents],
    ['POST', /^\/api\/goals\/([^/]+)\/assign$/,           handleGoalAssign],
    ['GET',  /^\/api\/goals\/([^/]+)\/pipeline$/,         handleGoalPipeline],
    ['GET',  /^\/api\/goals\/([^/]+)\/retro$/,            handleGoalRetro],
    ['GET',  /^\/api\/meetings\/debriefs\/pending$/,     handleGetPendingDebriefs],
    ['GET',  /^\/api\/meetings\/([^/]+)\/debrief$/,      handleGetDebrief],
    ['POST', /^\/api\/meetings\/([^/]+)\/debrief$/,      handleSaveDebrief],
    ['POST', /^\/api\/whatsapp\/lid-map$/,               handleSaveLidMap],
    ['GET',  /^\/api\/notifications$/,                   handleListNotifications],
    ['POST', /^\/api\/notifications\/([a-zA-Z]+)\/dismiss$/, handleDismissNotification],
    ['GET',  /^\/api\/self$/,                            handleGetSelfIdentity],
    ['POST', /^\/api\/self\/whatsapp$/,                  handleCaptureSelfWhatsapp],
    ['GET',  /^\/api\/meta$/,                            (req, res) => json(res, {
        demo: IS_DEMO,
        dataDir: DATA,
        persistedMode: readPersistedMode(),
        version: require('../package.json').version,
    })],
    ['GET',  /^\/api\/settings$/,                        handleGetSettings],
    ['POST', /^\/api\/settings\/mode$/,                  handleSetMode],
    ['POST', /^\/api\/settings\/seed-demo$/,             handleSeedDemo],
    ['POST', /^\/api\/settings\/linkedin-autosync$/,     handleSetLinkedinAutosync],
    ['POST', /^\/api\/settings\/oauth$/,                 handleSetOAuthConfig],
    ['GET',  /^\/api\/wa-pic\/([^/]+)$/,                   handleWhatsappProfilePic],
    ['GET',  /^\/api\/contacts\/([^/]+)\/timeline$/,     handleGetTimeline],
    ['GET',  /^\/api\/contacts\/([^/]+)\/interactions$/, handleGetInteractions],
    ['GET',  /^\/api\/contacts\/([^/]+)\/insights$/,     handleGetInsights],
    ['GET',  /^\/api\/contacts\/([^/]+)\/intro-paths$/,  handleGetIntroPaths],
    ['GET',  /^\/api\/intros\/find$/,                    handleFindIntroTargets],
    ['POST', /^\/api\/contacts\/([^/]+)\/regenerate-draft$/, handleRegenerateDraft],
    ['POST', /^\/api\/contacts\/([^/]+)\/notes$/,        handleSaveNotes],
    ['GET',  /^\/api\/contacts\/([^/]+)$/,               handleGetContact],
    ['GET',  /^\/api\/contacts$/,                        handleListContacts],
    ['GET',  /^\/api\/pending$/,                         handleGetPending],
    ['POST', /^\/api\/decide$/,                          handleDecide],
    ['GET',  /^\/api\/reconnect$/,                       handleGetReconnect],
    ['GET',  /^\/api\/network\/companies$/,               handleGetCompanies],
    ['GET',  /^\/api\/network\/edges$/,                   handleGetNetworkEdges],
    ['GET',  /^\/api\/intros$/,                           handleGetIntros],
    ['GET',  /^\/api\/digest$/,                           handleGetDigest],
    ['GET',  /^\/api\/search\/interactions$/,             handleSearchInteractions],
    ['GET',  /^\/api\/groups\/(.+)$/,                    handleGetGroupDetail],
    ['GET',  /^\/api\/groups$/,                          handleGetGroups],
    ['POST', /^\/api\/run-merge$/,                       handleRunMerge],
    ['GET',  /^\/api\/sync\/status$/,                    handleGetSyncStatus],
    ['POST', /^\/api\/sync\/trigger\/([^/]+)$/,          handleTriggerSync],
    ['GET',  /^\/api\/staleness$/,                       handleGetStaleness],
    ['GET',  /^\/api\/goals$/,                           handleGetGoals],
    ['POST', /^\/api\/goals$/,                           handleSaveGoals],
    ['GET',  /^\/api\/today$/,                           handleGetToday],
    ['GET',  /^\/api\/calendar\/upcoming$/,              handleGetCalendarUpcoming],
    ['POST', /^\/api\/network\/query$/,                  handleNetworkQuery],
];

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

// Single-user mode: every request uses this synthetic uuid as the cache key.
const SINGLE_USER_UUID = 'default';

// DNS-rebinding defence: accept only requests whose Host header matches an
// IP literal or loopback name that we actually listen on (or an entry the
// user explicitly allowlisted via MINTY_ALLOWED_HOSTS). The attacker needs
// a DOMAIN name to rebind, so IP-literal-only is the cheapest effective fix.
function buildAllowedHosts() {
    const set = new Set();
    const add = (h) => {
        if (!h) return;
        const low = h.toLowerCase();
        set.add(low);
        if (!/:\d+$/.test(low)) set.add(`${low}:${PORT}`);
    };
    add('localhost');
    add('127.0.0.1');
    add('[::1]');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const ni of nets[name] || []) {
            if (ni.family === 'IPv4' || ni.family === 4) add(ni.address);
            else if (ni.family === 'IPv6' || ni.family === 6) add(`[${ni.address}]`);
        }
    }
    for (const h of (process.env.MINTY_ALLOWED_HOSTS || '').split(',')) {
        add(h.trim());
    }
    return set;
}
const ALLOWED_HOSTS = buildAllowedHosts();

const server = http.createServer(async (req, res) => {
    const hostHeader = (req.headers.host || '').toLowerCase();
    if (!ALLOWED_HOSTS.has(hostHeader)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(`Forbidden: host "${hostHeader}" not in allowlist. Set MINTY_ALLOWED_HOSTS to include it.`);
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // OAuth callback (Google redirect flow)
    if (p === '/oauth/callback' && req.method === 'GET') { await handleOAuthCallback(req, res); return; }

    const uuid = SINGLE_USER_UUID;
    const paths = getUserPaths(uuid);

    // Serve the SPA at root
    if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML.replace("'__BASE__'", "''")); return;
    }

    if (p.startsWith('/api/')) {
        // Allow source management routes even when there are no contacts yet
        const isSourceRoute = p.startsWith('/api/sources');
        if (!isSourceRoute && !fs.existsSync(paths.contacts)) {
            if (p === '/api/contacts') { json(res, []); return; }
            if (p === '/api/pending')  { json(res, []); return; }
            if (p === '/api/goals')    { json(res, []); return; }
            if (p === '/api/today')    {
                json(res, { goals: [], goalSections: [], pulse: [], upcomingMeetings: [], generatedAt: new Date().toISOString() });
                return;
            }
            if (p === '/api/calendar/upcoming') {
                json(res, { meetings: [], lastSyncAt: null, status: 'idle' });
                return;
            }
            if (p === '/api/network/query') {
                json(res, { query: '', results: [], enhanced: false, processingMs: 0 });
                return;
            }
            res.writeHead(404); res.end('data not found'); return;
        }

        for (const [method, pattern, handler] of ROUTES) {
            if (req.method !== method) continue;
            const m = p.match(pattern);
            if (!m) continue;
            try {
                await handler(req, res, m.slice(1).map(decodeURIComponent), paths, uuid);
            } catch (e) {
                console.error(e);
                observability.captureException(e, { route: pattern.toString(), method });
                res.writeHead(500); res.end(e.message);
            }
            return;
        }
    }

    res.writeHead(404); res.end('not found');
});

server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  🌿 Minty is running' + (IS_DEMO ? '  ✨ DEMO mode' : ''));
    console.log(`     Local:  http://localhost:${PORT}`);
    console.log(`     Data:   ${DATA}`);
    if (HOST === '0.0.0.0') {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const ni of nets[name]) {
                if (ni.family === 'IPv4' && !ni.internal) {
                    console.log(`     LAN:    http://${ni.address}:${PORT}`);
                }
            }
        }
    }
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    console.log('');

    // Start background sync daemon for the single user
    try {
        ensureSyncDaemon(SINGLE_USER_UUID);
    } catch (e) {
        console.error('[sync] Failed to start sync daemon:', e.message);
    }

    // Auto-resume WhatsApp if previously paired. Stagger 5s after boot so the
    // sync daemon initializes first and we don't fight Puppeteer for the
    // event loop during startup.
    setTimeout(() => {
        try { autoResumeWhatsapp(SINGLE_USER_UUID); }
        catch (e) { console.error('[autosync] WhatsApp boot resume failed:', e.message); }
    }, 5 * 1000);
});

// ---------------------------------------------------------------------------
// HTML / CSS / JS (single-page app)
// ---------------------------------------------------------------------------

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Minty</title>
<style>
:root {
  --bg:             #0a0d14;
  --bg-card:        #111827;
  --bg-hover:       #1a2235;
  --border:         #1e2d45;
  --text-primary:   #f0f4ff;
  --text-secondary: #8892a4;
  --text-muted:     #4b5563;
  --health-strong:  #22c55e;
  --health-good:    #84cc16;
  --health-warm:    #f59e0b;
  --health-fading:  #f97316;
  --health-cold:    #ef4444;
  --health-none:    #374151;
  --accent:         #6366f1;
  --accent-hover:   #818cf8;
}
* { box-sizing: border-box; margin: 0; padding: 0; transition: background 180ms ease, color 180ms ease, border-color 180ms ease, opacity 180ms ease; }
/* Disable transition on elements where it causes flicker */
svg, path, circle, line, rect, .bubble-node *, canvas { transition: none !important; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: var(--bg); color: var(--text-primary); height: 100vh; display: flex; overflow: hidden; }

/* ---- Sidebar ---- */
nav {
  width: 56px;
  background: var(--bg-card);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column; flex-shrink: 0;
  overflow: hidden;
}
@media (min-width: 768px) { nav { width: 200px; } }
.nav-logo {
  padding: 16px 0;
  font-size: 1rem; font-weight: 800; color: var(--accent);
  letter-spacing: -0.04em; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; white-space: nowrap;
}
@media (min-width: 768px) { .nav-logo { padding: 16px 18px; justify-content: flex-start; } }
.nav-logo-icon { font-size: 1.3rem; }
.nav-logo-text { display: none; margin-left: 6px; }
@media (min-width: 768px) { .nav-logo-text { display: inline; } }
.nav-links { padding: 8px 4px; flex: 1; }
@media (min-width: 768px) { .nav-links { padding: 8px 6px; } }
.nav-link {
  display: flex; align-items: center; gap: 0;
  padding: 10px 0; justify-content: center;
  border-radius: 8px; cursor: pointer;
  color: var(--text-muted); font-size: 0.82rem; font-weight: 500;
  border: none; border-left: 3px solid transparent; background: none;
  width: 100%; text-align: left; white-space: nowrap; overflow: hidden;
}
@media (min-width: 768px) { .nav-link { gap: 10px; padding: 9px 10px; justify-content: flex-start; } }
.nav-link:hover { background: var(--bg-hover); color: var(--text-secondary); }
.nav-link.active {
  border-left-color: var(--accent);
  color: var(--text-primary);
  background: rgba(99, 102, 241, 0.08);
}
.nav-link.active .nav-icon { color: var(--accent); }
.nav-icon {
  width: 20px; height: 20px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: inherit; transition: color 180ms ease;
}
.nav-label { display: none; }
@media (min-width: 768px) { .nav-label { display: inline; } }
.nav-badge { margin-left: auto; background: var(--accent); color: #fff; border-radius: 10px;
             padding: 1px 7px; font-size: 0.7rem; font-weight: 700; }

/* ---- Main ---- */
#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* ---- Contact list view ---- */
#view-contacts { display: flex; flex-direction: column; height: 100%; }
.list-header { padding: 16px 20px; border-bottom: 1px solid #1e2740; display: flex;
               flex-direction: column; gap: 10px; flex-shrink: 0; }
.list-header h2 { font-size: 1rem; font-weight: 600; color: #94a3b8; }
.search-wrap { position: relative; }
.search-wrap input { width: 100%; background: var(--bg-card); border: 1px solid var(--border);
                     border-radius: 8px; padding: 9px 12px 9px 36px; color: var(--text-primary);
                     font-size: 0.875rem; outline: none; }
.search-wrap input:focus { border-color: var(--accent); }
.search-wrap input::placeholder { color: var(--text-muted); }
.search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
               color: #4a5568; font-size: 0.9rem; pointer-events: none; }
.source-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.sf { padding: 4px 10px; border-radius: 20px; border: 1px solid #2d3748; background: none;
      color: #64748b; font-size: 0.75rem; font-weight: 600; cursor: pointer;
      transition: all 0.1s; }
.sf:hover { border-color: #4a5568; color: #94a3b8; }
.sf.active { background: #1e2740; border-color: #4f46e5; color: #a78bfa; }
.list-count { font-size: 0.75rem; color: #4a5568; }

.contact-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; overflow-anchor: none; }
.contact-list * { overflow-anchor: none; }
.contact-item { display: flex; align-items: center; gap: 12px; padding: 0 16px;
                border-bottom: 1px solid rgba(30,45,69,0.5); cursor: pointer;
                box-sizing: border-box;
                height: 64px; overflow: hidden; }
.contact-item:hover { background: var(--bg-hover); transform: translateX(2px); }
.contact-item.kb-cursor { background: #1a2540 !important; outline: 1px solid var(--accent); outline-offset: -1px; }

/* Avatar with health ring */
.avatar-wrap { position: relative; width: 50px; height: 50px; flex-shrink: 0;
               display: flex; align-items: center; justify-content: center; }

/* Grid view */
.contact-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; padding: 12px; }
.contact-card { background: var(--bg-card); border: 1px solid var(--border); border-top: 2px solid var(--border);
                border-radius: 12px; padding: 14px 10px 12px; cursor: pointer;
                display: flex; flex-direction: column; align-items: center; gap: 7px; }
.contact-card:hover { border-color: var(--accent); background: var(--bg-hover); box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
.contact-card.kb-cursor { outline: 2px solid #4f46e5; outline-offset: -1px; background: #1e2740; }
.contact-card.score-strong { border-top-color: var(--health-strong); }
.contact-card.score-good   { border-top-color: var(--health-warm); }
.contact-card.score-weak   { border-top-color: var(--health-fading); }
.contact-card.score-cold   { border-top-color: var(--health-cold); }
.card-name { font-size: 0.78rem; font-weight: 600; color: #e2e8f0; white-space: nowrap;
             overflow: hidden; text-overflow: ellipsis; width: 100%; text-align: center; }
.card-sub { font-size: 0.65rem; color: #4a5568; white-space: nowrap; overflow: hidden;
            text-overflow: ellipsis; width: 100%; text-align: center; }
.card-last { font-size: 0.65rem; color: #374151; }

/* View toggle */
.view-toggle { display: flex; gap: 2px; background: #12172a; border: 1px solid #2d3748;
               border-radius: 6px; padding: 2px; }
.vt-btn { background: none; border: none; cursor: pointer; padding: 3px 8px;
          border-radius: 4px; color: #4a5568; font-size: 0.75rem; line-height: 1; }
.vt-btn.active { background: #1e2740; color: #a78bfa; }

/* Letter sidebar */
.contact-list-wrap { position: relative; flex: 1; overflow: hidden; display: flex; }
.letter-sidebar { position: absolute; right: 0; top: 0; bottom: 0; display: flex;
                  flex-direction: column; justify-content: center; gap: 0; z-index: 5;
                  padding: 4px 2px; }
.letter-btn { background: none; border: none; color: #4a5568; font-size: 0.58rem;
              font-weight: 700; cursor: pointer; padding: 1px 4px; line-height: 1.4;
              min-width: 18px; text-align: center; border-radius: 3px; }
.letter-btn:hover { color: #a78bfa; background: #1e2740; }
.last-contact { font-size: 12px; color: var(--text-muted); flex-shrink: 0; text-align: right;
                min-width: 36px; font-variant-numeric: tabular-nums; }
.sort-bar { display: flex; align-items: center; gap: 6px; }
.sort-bar label { font-size: 0.72rem; color: #4a5568; }
.sort-select { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 6px;
               color: #64748b; font-size: 0.72rem; padding: 3px 6px; cursor: pointer; outline: none; }
.avatar { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center;
          justify-content: center; font-size: 0.9rem; font-weight: 600; flex-shrink: 0;
          letter-spacing: -0.02em; }
.contact-info { flex: 1; min-width: 0; }
.contact-name { font-size: 15px; font-weight: 500; letter-spacing: -0.02em; color: var(--text-primary);
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.contact-meta { font-size: 0.78rem; color: #64748b; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.contact-meta .sep { margin: 0 4px; }
.contact-company { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
                   color: var(--text-muted); font-weight: 500;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.source-dots { display: flex; gap: 4px; flex-shrink: 0; align-items: center; }
.dot { width: 6px; height: 6px; border-radius: 50%; }
.dot-whatsapp { background: #34d399; }
.dot-linkedin  { background: #60a5fa; }
.dot-googleContacts { background: #f97316; }
.dot-sms { background: #c084fc; }
.dot-telegram { background: #38bdf8; }
.dot-email { background: #facc15; }
.dot-stale { font-size: 9px; color: var(--health-warm); line-height: 1; opacity: 0.85; }

.empty-state { text-align: center; padding: 60px 20px; }

/* ---- Health cohort bar ---- */
.health-bar-wrap { padding: 10px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.health-bar { height: 6px; border-radius: 3px; display: flex; gap: 2px; overflow: hidden;
              margin-bottom: 8px; }
.health-seg { cursor: pointer; border-radius: 2px; min-width: 3px; flex-shrink: 0;
              transition: opacity 180ms ease; }
.health-seg:hover { opacity: 0.75; }
.health-seg.hs-active { outline: 2px solid rgba(255,255,255,0.6); outline-offset: 1px; }
.health-summary { display: flex; gap: 10px; flex-wrap: wrap; }
.health-stat { font-size: 11px; font-weight: 500; cursor: pointer; letter-spacing: 0.03em;
               transition: opacity 180ms ease; opacity: 0.8; }
.health-stat:hover { opacity: 1; }
.health-stat.hs-active { opacity: 1; text-decoration: underline; text-underline-offset: 2px; }
.load-more { text-align: center; padding: 12px; }
.load-more button { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 7px;
                    padding: 7px 20px; color: #64748b; font-size: 0.8rem; cursor: pointer; }
.load-more button:hover { color: #94a3b8; }

/* ---- Contact detail view ---- */
#view-contact { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
/* Hero header */
.contact-hero { background: var(--bg-card); border-bottom: 1px solid var(--border);
                padding: 18px 20px; flex-shrink: 0; display: flex; align-items: center;
                gap: 16px; min-height: 110px; }
.back-btn { background: none; border: none; color: var(--text-muted); cursor: pointer;
            font-size: 1.1rem; padding: 4px 8px; border-radius: 5px; flex-shrink: 0; align-self: flex-start; }
.back-btn:hover { color: var(--text-secondary); background: var(--bg-hover); }
.hero-avatar-wrap { position: relative; width: 80px; height: 80px; flex-shrink: 0; }
.hero-avatar { width: 72px; height: 72px; border-radius: 50%; display: flex;
               align-items: center; justify-content: center; font-size: 1.4rem;
               font-weight: 700; position: absolute; top: 4px; left: 4px; }
.hero-ring-svg { position: absolute; top: 0; left: 0; transform: rotate(-90deg); overflow: visible; }
.hero-ring-track { fill: none; stroke: var(--border); stroke-width: 3; }
.hero-ring-fill  { fill: none; stroke-width: 3; stroke-linecap: round;
                   transition: stroke-dashoffset 0.8s ease; }
.hero-info { flex: 1; min-width: 0; }
.hero-name  { font-size: 20px; font-weight: 600; letter-spacing: -0.02em;
              color: var(--text-primary); margin-bottom: 4px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hero-role  { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
              color: var(--text-muted); font-weight: 500; margin-bottom: 6px; }
.hero-known { font-size: 12px; color: var(--text-muted); }
.hero-score-col { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.hero-score-num  { font-size: 36px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; }
.hero-score-bar  { width: 60px; height: 4px; background: var(--border); border-radius: 2px; margin-top: 2px; }
.hero-score-fill { height: 4px; border-radius: 2px; }
.hero-score-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
                    color: var(--text-muted); font-weight: 600; }
.hero-last-contact { font-size: 11px; color: var(--text-secondary); text-align: right; margin-top: 4px; }
.hero-source-dots { display: flex; gap: 5px; margin-top: 4px; justify-content: flex-end; }
.engagement-chips { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; margin-top: 4px; }
.engagement-chip {
  font-size: 10px; padding: 2px 6px; border-radius: 10px;
  border: 1px solid var(--border); background: rgba(99,102,241,0.05);
  color: var(--text-secondary); letter-spacing: 0.01em;
}

/* @-mentions */
.mention-link {
  color: var(--accent-hover); cursor: pointer; text-decoration: none;
  font-weight: 500; border-bottom: 1px dotted var(--accent-hover);
  padding-bottom: 1px;
}
.mention-link:hover { color: var(--accent); border-bottom-style: solid; }
.backlinks-list { display: flex; flex-direction: column; gap: 8px; }
.backlink-row {
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; transition: border-color 180ms ease;
}
.backlink-row:hover { border-color: var(--accent); }
.backlink-from { font-size: 13px; color: var(--text-primary); font-weight: 500; }
.backlink-snippet { font-size: 11px; color: var(--text-secondary); margin-top: 2px; line-height: 1.5; }
.hero-source-dot { width: 8px; height: 8px; border-radius: 50%; cursor: default; }
/* Quick actions strip */
.quick-actions { display: flex; gap: 8px; padding: 8px 20px;
                 border-bottom: 1px solid var(--border); background: var(--bg); flex-shrink: 0; flex-wrap: wrap; }
.qa-btn { display: flex; align-items: center; gap: 5px; padding: 5px 12px;
          border: 1px solid var(--border); border-radius: 20px; background: none;
          color: var(--text-secondary); font-size: 12px; cursor: pointer;
          transition: all 180ms ease; white-space: nowrap; font-family: inherit; }
.qa-btn:hover { border-color: var(--accent); color: var(--text-primary); background: rgba(99,102,241,0.08); }
/* Score override (moved inline) */
.score-override-panel { position: absolute; top: 100%; right: 0; background: var(--bg-card);
                         border: 1px solid var(--border); border-radius: 8px; padding: 10px;
                         z-index: 10; display: flex; align-items: center; gap: 8px; white-space: nowrap; }

.detail-body { flex: 1; overflow-y: auto; padding: 20px; display: grid;
               grid-template-columns: 1fr 320px; gap: 20px; align-content: start; }
@media (max-width: 900px) { .detail-body { grid-template-columns: 1fr; } }

.detail-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
                  padding: 16px; margin-bottom: 16px; }
.detail-section h3 { font-size: 11px; font-weight: 600; letter-spacing: 0.1em;
                     color: var(--text-muted); text-transform: uppercase; margin-bottom: 12px; }
.info-grid { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px;
             align-items: start; font-size: 0.85rem; }
.info-label { color: #64748b; }
.info-value { color: #cbd5e1; word-break: break-all; }
.info-value a { color: #60a5fa; text-decoration: none; }
.info-value a:hover { text-decoration: underline; }
.info-value.empty { color: #374151; font-style: italic; }

.notes-area { width: 100%; background: #12172a; border: 1px solid #2d3748; border-radius: 7px;
              padding: 10px 12px; color: #cbd5e1; font-size: 0.85rem; resize: vertical;
              min-height: 100px; font-family: inherit; outline: none; }
.notes-area:focus { border-color: #4f46e5; }
.notes-saved { font-size: 0.75rem; color: #4a5568; margin-top: 6px; height: 16px;
               transition: opacity 0.3s; }

.source-block { margin-bottom: 12px; }
.source-block:last-child { margin-bottom: 0; }
.source-block-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }

/* ---- Relationship timeline ---- */
.rel-timeline { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
                padding: 14px 16px; margin-bottom: 16px; }
.rel-timeline-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.rel-timeline-title { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; color: var(--text-muted); text-transform: uppercase; }
.rel-arc { font-size: 0.68rem; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
.arc-growing  { background: #064e3b; color: #34d399; }
.arc-stable   { background: #1e2740; color: #64748b; }
.arc-fading   { background: #422006; color: #f97316; }
.arc-revived  { background: #312e81; color: #a78bfa; }
.rel-timeline-meta { font-size: 0.72rem; color: #4a5568; margin-top: 8px; display: flex; gap: 16px; }

/* ---- Insights card ---- */
.insights-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.insights-card h3 { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; color: var(--text-muted);
                    text-transform: uppercase; margin-bottom: 12px; }
.insight-brief { font-size: 0.84rem; color: var(--text-secondary); line-height: 1.7; margin-bottom: 14px; }
.insight-meta { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; font-size: 0.75rem; color: #4a5568; }
.insight-meta span { color: #64748b; }
.mini-timeline { margin-bottom: 14px; }
.mini-timeline-title { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.07em; color: #4a5568; text-transform: uppercase; margin-bottom: 8px; }
.mini-msg { display: flex; gap: 8px; padding: 5px 0; border-bottom: 1px solid #1a2035; font-size: 0.76rem; align-items: flex-start; }
.mini-msg:last-child { border-bottom: none; }
.mini-msg-src { width: 52px; flex-shrink: 0; font-weight: 600; font-size: 0.68rem; padding-top: 2px; }
.mini-msg-date { color: #4a5568; width: 64px; flex-shrink: 0; font-size: 0.68rem; padding-top: 2px; }
.mini-msg-body { color: #94a3b8; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topic-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.topic-tag { background: none; color: var(--text-secondary); font-size: 0.72rem; padding: 3px 10px;
             border-radius: 20px; border: 1px solid var(--border); }
.open-loops { list-style: none; }
.open-loops li { font-size: 0.8rem; color: var(--text-secondary); padding: 6px 0;
                 border-bottom: 1px solid var(--border);
                 display: flex; gap: 8px; align-items: flex-start; line-height: 1.5; }
.open-loops li:last-child { border-bottom: none; }
.loop-icon { flex-shrink: 0; margin-top: 1px; color: var(--accent); }
.sentiment-pill { display: inline-block; font-size: 0.68rem; font-weight: 700; padding: 2px 8px;
                  border-radius: 20px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
.sentiment-warm    { background: #064e3b; color: #34d399; }
.sentiment-neutral { background: #1e3a5f; color: #60a5fa; }
.sentiment-cooling { background: #422006; color: #f97316; }
.sentiment-cold    { background: #3b1818; color: #ef4444; }

/* ---- Reconnect view ---- */
#view-reconnect { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.reconnect-header { padding: 16px 20px; border-bottom: 1px solid #1e2740; flex-shrink: 0; }
.reconnect-header h2 { font-size: 1rem; font-weight: 600; margin-bottom: 4px; }
.reconnect-header p { font-size: 0.8rem; color: #4a5568; }
.reconnect-list { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.reconnect-card { background: #1a1f2e; border: 1px solid #1e2740; border-radius: 10px; padding: 14px 16px;
                  display: flex; flex-direction: column; gap: 8px; }
.reconnect-top { display: flex; align-items: center; gap: 12px; }
.reconnect-info { flex: 1; min-width: 0; }
.reconnect-name { font-size: 0.95rem; font-weight: 600; color: #f1f5f9;
                  cursor: pointer; text-decoration: none; }
.reconnect-name:hover { color: #a78bfa; }
.reconnect-role { font-size: 0.78rem; color: #64748b; margin-top: 2px;
                  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reconnect-age { font-size: 0.8rem; font-weight: 600; color: #f97316; flex-shrink: 0; text-align: right; }
.reconnect-snippet { font-size: 0.78rem; color: #475569; background: #0f1117; border-radius: 6px;
                     padding: 8px 10px; border-left: 3px solid #1e2740; font-style: italic;
                     white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reconnect-bottom { display: flex; align-items: center; justify-content: space-between; }
.reconnect-actions { display: flex; gap: 6px; }
.btn-reconnect { padding: 5px 12px; background: #1e2740; border: 1px solid #2d3748;
                 border-radius: 6px; color: #94a3b8; font-size: 0.75rem; cursor: pointer; }
.btn-reconnect:hover { border-color: #4f46e5; color: #a78bfa; }
.reconnect-empty { text-align: center; padding: 60px 20px; color: #4a5568; }

/* ---- Today view ---- */
#view-today { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.today-scroll { flex: 1; overflow-y: auto; padding: 24px 28px; display: flex; flex-direction: column; gap: 28px; }

/* Goals strip */
.goals-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.goal-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 20px; padding: 6px 14px 6px 10px;
  font-size: 0.82rem; color: var(--text-primary); cursor: pointer;
  transition: border-color 180ms ease, background 180ms ease;
}
.goal-chip.active { border-color: var(--accent); background: rgba(99,102,241,0.12); color: #a5b4fc; }
.goal-chip:hover:not(.active) { border-color: var(--accent); }
.goal-chip-remove {
  background: none; border: none; color: var(--text-muted); cursor: pointer;
  font-size: 0.9rem; line-height: 1; padding: 0 0 0 2px;
}
.goal-chip-remove:hover { color: var(--health-cold); }
.goal-add-btn {
  display: inline-flex; align-items: center; gap: 5px;
  background: none; border: 1px dashed var(--border); border-radius: 20px;
  padding: 6px 12px; color: var(--text-muted); font-size: 0.82rem; cursor: pointer;
  transition: border-color 180ms ease, color 180ms ease;
}
.goal-add-btn:hover { border-color: var(--accent); color: var(--accent); }
.goal-input-wrap { display: flex; align-items: center; gap: 8px; }
.goal-input {
  background: var(--bg-card); border: 1px solid var(--accent);
  border-radius: 20px; padding: 6px 14px; color: var(--text-primary);
  font-size: 0.82rem; outline: none; min-width: 240px;
}

/* Today section blocks */
.today-section { display: flex; flex-direction: column; gap: 12px; }
.today-section-header {
  font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-muted); display: flex; align-items: center; gap: 8px;
}
.today-section-header::after {
  content: ''; flex: 1; height: 1px; background: var(--border);
}

/* Meeting card variant — time column + body */
.meeting-card { cursor: default; }
.meeting-card:hover { border-color: rgba(99,102,241,0.3); }

/* Goal contact card — large, full-width */
.today-card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
  padding: 16px 18px; display: flex; align-items: flex-start; gap: 14px;
  cursor: pointer; transition: border-color 180ms ease, background 180ms ease;
}
.today-card:hover { border-color: rgba(99,102,241,0.5); background: var(--bg-hover); }
.today-card-avatar { position: relative; flex-shrink: 0; width: 50px; height: 50px; }
.today-card-avatar svg { position: absolute; top: 0; left: 0; }
.today-card-avatar-inner {
  width: 44px; height: 44px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.85rem; font-weight: 600; position: absolute; top: 3px; left: 3px;
}
.today-card-body { flex: 1; min-width: 0; }
.today-card-name { font-size: 15px; font-weight: 500; letter-spacing: -0.02em; color: var(--text-primary); }
.today-card-role { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
                   color: var(--text-muted); margin-top: 2px; font-weight: 500; }
.today-card-why {
  margin-top: 6px; font-size: 0.78rem; color: var(--text-secondary); line-height: 1.5;
  background: rgba(255,255,255,0.02); border-left: 2px solid var(--accent);
  padding: 4px 8px; border-radius: 0 4px 4px 0;
}
.today-card-meta { margin-top: 6px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.today-card-score { font-size: 0.75rem; color: var(--text-muted); }
.today-card-score span { color: var(--text-secondary); font-weight: 500; }
.today-card-days { font-size: 0.75rem; color: var(--text-muted); }
.today-card-topics { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px; }
.today-card-topic { font-size: 0.68rem; background: rgba(99,102,241,0.08); border: 1px solid rgba(99,102,241,0.2);
                    color: #a5b4fc; border-radius: 4px; padding: 2px 7px; }

/* Empty state for today */
.today-empty { text-align: center; padding: 48px 20px; }
.today-empty-icon { font-size: 2rem; margin-bottom: 12px; }
.today-empty-title { font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.today-empty-sub { font-size: 0.83rem; color: var(--text-muted); line-height: 1.5; }
/* Sync warning banner */
.sync-warn-banner {
  display: flex; align-items: flex-start; gap: 8px; padding: 10px 14px;
  border-radius: 8px; font-size: 0.82rem; line-height: 1.4;
  border: 1px solid; cursor: pointer; transition: opacity 180ms ease;
}
.sync-warn-banner.warning {
  background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.3); color: var(--health-warm);
}
.sync-warn-banner.error {
  background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.3); color: var(--health-cold);
}
.sync-warn-banner svg { flex-shrink: 0; margin-top: 1px; }
.sync-warn-icon { width: 14px; height: 14px; }

/* Sticky re-auth banner (set by auto-sync on session failure) */
.notif-banner {
  position: sticky; top: 0; z-index: 50;
  display: flex; align-items: flex-start; gap: 10px;
  background: rgba(180, 83, 9, 0.96); color: #fff;
  padding: 10px 14px; font-size: 0.78rem; line-height: 1.35;
  box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  border-bottom: 1px solid rgba(0,0,0,0.15);
}
.notif-banner-text { flex: 1; }
.notif-banner-source { font-weight: 600; margin-right: 6px; text-transform: capitalize; }
.notif-banner-action {
  background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3);
  color: #fff; padding: 4px 10px; border-radius: 6px;
  font-size: 0.72rem; cursor: pointer; white-space: nowrap;
}
.notif-banner-action:hover { background: rgba(255,255,255,0.28); }
.notif-banner-dismiss {
  background: transparent; border: 0; color: #fff; opacity: 0.7;
  font-size: 1rem; cursor: pointer; padding: 0 4px; line-height: 1;
}
.notif-banner-dismiss:hover { opacity: 1; }

/* Global sync toast (shown while a background import is running) */
.sync-toast {
  position: fixed; top: 14px; right: 14px; z-index: 60;
  display: flex; align-items: center; gap: 10px;
  background: rgba(17, 24, 39, 0.92); backdrop-filter: blur(8px);
  border: 1px solid rgba(99,102,241,0.35);
  padding: 10px 14px 10px 12px; border-radius: 10px;
  font-size: 0.78rem; color: #e5e7eb;
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  max-width: 360px; cursor: pointer;
  transition: opacity 180ms ease, transform 180ms ease;
}
.sync-toast:hover { transform: translateY(-1px); }
.sync-toast.success { border-color: rgba(52,211,153,0.4); }
.sync-toast.success .sync-toast-spinner { animation: none; border-top-color: #34d399; border-color: #34d399; }
.sync-toast-text { line-height: 1.35; }
.sync-toast-spinner {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid rgba(167,139,250,0.3); border-top-color: #a78bfa;
  animation: sync-toast-spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes sync-toast-spin { to { transform: rotate(360deg); } }
.sync-toast-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(99,102,241,0.12); border-bottom-left-radius: 10px; border-bottom-right-radius: 10px; overflow: hidden; }
.sync-toast-bar-fill { height: 100%; width: 0%; background: #a78bfa; transition: width 0.3s ease; }
@media (max-width: 720px) {
  .sync-toast { top: auto; bottom: 76px; right: 10px; left: 10px; max-width: none; }
}

/* ----- Command palette ----- */
.palette-overlay {
  position: fixed; inset: 0;
  background: rgba(6, 10, 20, 0.72);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: none;
  align-items: flex-start; justify-content: center;
  padding-top: 15vh;
  z-index: 9998;
  animation: palette-fade 180ms ease;
}
.palette-overlay.open { display: flex; }
@keyframes palette-fade { from { opacity: 0; } to { opacity: 1; } }
.palette {
  width: min(640px, 92vw);
  background: #0e1526;
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 30px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02);
  overflow: hidden;
  display: flex; flex-direction: column;
  max-height: 60vh;
}
.palette-input-wrap {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px; border-bottom: 1px solid var(--border);
}
.palette-icon { color: var(--text-secondary); flex-shrink: 0; }
#palette-input {
  flex: 1; background: transparent; border: 0; outline: 0;
  color: var(--text-primary); font-size: 15px; letter-spacing: -0.01em;
  font-family: inherit;
}
#palette-input::placeholder { color: var(--text-muted); }
.palette-hint { color: var(--text-muted); font-size: 11px; display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; }
.palette-hint kbd {
  background: #1a2235; border: 1px solid var(--border);
  border-radius: 4px; padding: 1px 5px; font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-secondary);
}
.palette-results { overflow-y: auto; }
.palette-group { padding: 6px 0; }
.palette-group-label {
  padding: 8px 16px 4px;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--text-muted); font-weight: 600;
}
.palette-item {
  padding: 8px 16px;
  display: flex; align-items: center; gap: 12px;
  cursor: pointer; transition: background 120ms ease;
}
.palette-item:hover,
.palette-item.active { background: #1a2235; }
.palette-item-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: linear-gradient(135deg, #4f46e5, #818cf8);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; color: white; flex-shrink: 0;
}
.palette-item-body { flex: 1; min-width: 0; }
.palette-item-title {
  color: var(--text-primary); font-size: 14px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.palette-item-sub {
  color: var(--text-secondary); font-size: 12px; margin-top: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.palette-item-type {
  font-size: 10px; padding: 2px 6px; border-radius: 4px;
  background: rgba(99,102,241,0.12); color: var(--accent-hover);
  text-transform: uppercase; letter-spacing: 0.06em;
  flex-shrink: 0;
}
.palette-empty {
  padding: 24px 16px; text-align: center; color: var(--text-muted); font-size: 13px;
}
.palette-score-ring {
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--health-none); flex-shrink: 0;
}
.palette-score-ring.strong { background: var(--health-strong); }
.palette-score-ring.good   { background: var(--health-good); }
.palette-score-ring.warm   { background: var(--health-warm); }
.palette-score-ring.fading { background: var(--health-fading); }
.palette-score-ring.cold   { background: var(--health-cold); }
@media (max-width: 720px) {
  .palette-overlay { padding-top: 10vh; }
  .palette-hint { display: none; }
}

/* Pulse section */
.pulse-item {
  display: flex; align-items: center; gap: 12px; padding: 10px 14px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; transition: border-color 180ms ease;
}
.pulse-item:hover { border-color: rgba(99,102,241,0.4); }
.pulse-item-name { font-size: 0.88rem; font-weight: 500; color: var(--text-primary); flex: 1; min-width: 0; }
.pulse-item-meta { font-size: 0.73rem; color: var(--text-muted); }

.goal-pipeline-summary { display: inline-flex; gap: 4px; margin-left: 10px; vertical-align: middle; }
.goal-stage-pill {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; font-weight: 500;
  padding: 2px 6px; border-radius: 8px;
  background: rgba(99,102,241,0.08); border: 1px solid var(--border);
  color: var(--text-secondary);
}
.goal-stage-pill.active { background: rgba(99,102,241,0.16); color: var(--text-primary); }
.goal-stage-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.goal-stage-dot.s0 { background: #6b7280; }
.goal-stage-dot.s1 { background: #a78bfa; }
.goal-stage-dot.s2 { background: #60a5fa; }
.goal-stage-dot.s3 { background: #34d399; }
.goal-stage-dot.s4 { background: #22c55e; }

.today-card-stage-row { margin-top: 8px; }
.today-card-stage-select {
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  border-radius: 6px; padding: 4px 8px;
  font-size: 11px; font-family: inherit;
  cursor: pointer;
}
.today-card-stage-select:hover, .today-card-stage-select:focus {
  border-color: var(--accent); outline: 0; color: var(--text-primary);
}

.life-event-badge {
  position: absolute; right: -4px; bottom: -4px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 50%;
  width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;
  font-size: 10px;
}

/* (health-strip tiles removed — replaced by health-bar-wrap in HTML and CSS above) */

/* ---- Review view ---- */
#view-review { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.review-header { padding: 14px 20px; border-bottom: 1px solid #1e2740;
                 display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.review-header h2 { font-size: 1rem; font-weight: 600; }
.progress-wrap { display: flex; align-items: center; gap: 10px; }
.progress-bar { width: 160px; height: 5px; background: #1e2740; border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: #a78bfa; transition: width 0.3s; }
.progress-text { font-size: 0.8rem; color: #64748b; }
.merge-btn { padding: 6px 14px; background: #4f46e5; border: none; border-radius: 6px;
             color: #fff; font-size: 0.8rem; cursor: pointer; }
.merge-btn:hover { background: #4338ca; }
.review-body { flex: 1; overflow-y: auto; padding: 20px; }

.card { background: #1a1f2e; border: 1px solid #1e2740; border-radius: 12px; overflow: hidden; }
.reason-bar { background: #12172a; border-bottom: 1px solid #1e2740;
              padding: 10px 18px; display: flex; align-items: center; gap: 8px; }
.reason-bar .tag { background: #312e81; color: #c4b5fd; border-radius: 4px;
                   padding: 2px 8px; font-size: 0.7rem; font-weight: 700; }
.reason-bar .tag.tag-skip { background: #3b1818; color: #fca5a5; }
.reason-bar .tag.tag-unsure { background: #2d2a1a; color: #fcd34d; }
.reason-bar .tag.tag-confirmed { background: #064e3b; color: #6ee7b7; }
.reason-bar .tag.tag-likely { background: #1e3a5f; color: #93c5fd; }
.reason-text { font-size: 0.82rem; color: #64748b; flex: 1; }
.contacts-row { display: grid; grid-template-columns: 1fr 1fr; }
.contact-panel { padding: 18px; }
.contact-panel:first-child { border-right: 1px solid #1e2740; }
.panel-badge { display: inline-block; margin-bottom: 8px; font-size: 0.72rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
.badge-whatsapp { background: #064e2b; color: #34d399; }
.badge-linkedin { background: #1e3a5f; color: #60a5fa; }
.badge-googleContacts { background: #431407; color: #fb923c; }
.badge-sms { background: #3b0764; color: #c084fc; }
.badge-email { background: #422006; color: #facc15; }
.panel-name { font-size: 1.05rem; font-weight: 700; color: #f1f5f9; margin-bottom: 10px; }
.field { display: flex; gap: 8px; margin-bottom: 6px; font-size: 0.82rem; }
.field-label { color: #64748b; min-width: 75px; flex-shrink: 0; }
.field-value { color: #cbd5e1; word-break: break-all; }
.msg-toggle { margin-top: 10px; background: none; border: 1px solid #1e2d45; color: #6366f1;
  border-radius: 6px; padding: 4px 10px; font-size: 0.75rem; cursor: pointer; }
.msg-toggle:hover { background: #1e2d45; }
.msg-preview { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
.msg-bubble { padding: 7px 10px; border-radius: 8px; font-size: 0.78rem; max-width: 90%; }
.msg-sent { background: #1e3a5f; color: #bfdbfe; align-self: flex-end; }
.msg-recv { background: #1a1f2e; color: #cbd5e1; align-self: flex-start; }
.msg-body { line-height: 1.4; }
.msg-date { font-size: 0.68rem; color: #475569; margin-top: 3px; }
.msg-empty { color: #475569; font-size: 0.8rem; padding: 6px 0; }
.field-value a { color: #60a5fa; text-decoration: none; }
.actions { display: flex; gap: 8px; padding: 14px 18px; border-top: 1px solid #1e2740;
           background: #12172a; }
.actions button { flex: 1; padding: 9px; border: none; border-radius: 7px;
                  font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: opacity 0.1s; }
.actions button:hover { opacity: 0.85; }
.btn-confirm { background: #065f46; color: #6ee7b7; }
.btn-likely  { background: #1e3a5f; color: #93c5fd; }
.btn-unsure  { background: #2d2a1a; color: #fcd34d; }
.btn-skip    { background: #3b1818; color: #fca5a5; }
.btn-back    { background: #1e2433; color: #64748b; border: 1px solid #2d3748;
               flex: 0 0 auto !important; padding: 9px 12px !important; }
.btn-selected { outline: 2px solid rgba(255,255,255,0.4); filter: brightness(1.5); }
.kbd { display: inline-block; background: #2d3748; border: 1px solid #4a5568;
       border-radius: 3px; padding: 0 5px; font-size: 0.68rem; color: #64748b;
       font-family: monospace; margin-left: 3px; }
.merge-output { background: #0f1117; border: 1px solid #1e2740; border-radius: 7px;
                padding: 14px; margin-top: 14px; font-family: monospace; font-size: 0.78rem;
                color: #86efac; white-space: pre-wrap; max-height: 180px; overflow-y: auto;
                display: none; }
.review-empty { text-align: center; padding: 60px 0; color: #4a5568; }
.review-empty h2 { font-size: 1.3rem; margin-bottom: 8px; color: #64748b; }

/* ---- Digest ---- */
#view-digest { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.digest-summary { background: #12172a; border: 1px solid #1e2740; border-radius: 10px; padding: 18px; }
.digest-summary h3 { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; color: #4a5568;
                     text-transform: uppercase; margin-bottom: 12px; }
.digest-summary p { font-size: 0.875rem; color: #94a3b8; line-height: 1.7; white-space: pre-line; }
.digest-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.digest-stat { background: #1a1f2e; border: 1px solid #1e2740; border-radius: 8px; padding: 10px 12px; text-align: center; }
.digest-stat-num { font-size: 1.4rem; font-weight: 700; color: #a78bfa; }
.digest-stat-label { font-size: 0.65rem; color: #4a5568; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.06em; }
.digest-section { background: #1a1f2e; border: 1px solid #1e2740; border-radius: 10px; padding: 16px; }
.digest-section h3 { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; color: #4a5568;
                     text-transform: uppercase; margin-bottom: 12px; }
.digest-contact-row { display: flex; align-items: center; gap: 10px; padding: 6px 0;
                       border-bottom: 1px solid #0f1117; cursor: pointer; }
.digest-contact-row:last-child { border-bottom: none; }
.digest-contact-row:hover .digest-contact-name { color: #a78bfa; }
.digest-contact-name { font-size: 0.875rem; font-weight: 600; color: #e2e8f0; flex: 1; }
.digest-contact-meta { font-size: 0.72rem; color: #64748b; }
.digest-loop-contact { font-size: 0.8rem; font-weight: 600; color: #fbbf24; margin-bottom: 2px; }
.digest-loop-text { font-size: 0.78rem; color: #94a3b8; line-height: 1.4; }
.digest-loop-item { padding: 7px 0; border-bottom: 1px solid #0f1117; }
.digest-loop-item:last-child { border-bottom: none; }
.digest-generated { font-size: 0.7rem; color: #374151; text-align: center; }

/* ---- Intros ---- */
#view-intros { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.intro-finder-wrap {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px;
}
#intro-find-input {
  flex: 1; background: transparent; border: 0; outline: 0;
  color: var(--text-primary); font-size: 14px; font-family: inherit;
}
#intro-find-input::placeholder { color: var(--text-muted); }
.intro-target-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 10px; padding: 14px; margin-bottom: 10px;
}
.intro-target-head {
  display: flex; align-items: center; gap: 12px; margin-bottom: 8px;
  cursor: pointer;
}
.intro-target-name { font-size: 15px; font-weight: 500; color: var(--text-primary); letter-spacing: -0.02em; }
.intro-target-role { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
.intro-paths-head {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--text-muted); font-weight: 600; margin: 10px 0 6px;
}
.intro-path-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: border-color 180ms ease;
}
.intro-path-row:hover { border-color: var(--accent); }
.intro-path-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: linear-gradient(135deg, #4f46e5, #818cf8);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; color: white; flex-shrink: 0;
}
.intro-path-body { flex: 1; min-width: 0; }
.intro-path-groups {
  font-size: 11px; color: var(--text-muted); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.intro-path-score {
  font-size: 11px; color: var(--text-secondary);
  background: rgba(99,102,241,0.1); padding: 2px 8px; border-radius: 10px;
  flex-shrink: 0;
}
.intro-no-paths {
  font-size: 12px; color: var(--text-muted); font-style: italic; padding: 8px 0;
}
.intro-card { background: #1a1f2e; border: 1px solid #1e2740; border-radius: 10px;
              padding: 14px 16px; margin: 10px 20px; }
.intro-pair { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.intro-person { flex: 1; min-width: 0; }
.intro-name { font-size: 0.9rem; font-weight: 600; color: #e2e8f0; cursor: pointer; }
.intro-name:hover { color: #a78bfa; }
.intro-role { font-size: 0.72rem; color: #64748b; margin-top: 2px;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.intro-connector { color: #4a5568; font-size: 0.8rem; flex-shrink: 0; }
.intro-reason { display: inline-block; font-size: 0.68rem; font-weight: 700; padding: 2px 8px;
                border-radius: 10px; background: #1e3a5f; color: #60a5fa;
                text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
.intro-value { font-size: 0.68rem; color: #4a5568; margin-left: 8px; }
.btn-copy-intro { padding: 6px 14px; background: #1e2740; border: 1px solid #2d3748;
                  border-radius: 6px; color: #94a3b8; font-size: 0.75rem; cursor: pointer; }
.btn-copy-intro:hover { border-color: #4f46e5; color: #a78bfa; }
.btn-copy-intro.copied { border-color: #34d399; color: #34d399; }

/* ---- Network map (D3 bubble graph) ---- */
#view-network { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
#network-svg { cursor: grab; }
#network-svg:active { cursor: grabbing; }
.bubble-node { cursor: pointer; }
.bubble-node circle { transition: stroke-width 0.15s, filter 0.15s; }
.bubble-node:hover circle { stroke-width: 3; filter: brightness(1.3); }
.bubble-node.selected circle { stroke-width: 3; stroke: #a78bfa !important; }
.bubble-node.dimmed circle { opacity: 0.2; }
.bubble-node.dimmed text { opacity: 0.1; }
.net-detail-company { font-size: 0.95rem; font-weight: 700; color: #f1f5f9; margin-bottom: 4px; }
.net-detail-meta { font-size: 0.72rem; color: #64748b; margin-bottom: 12px; }
.net-detail-contact { display: flex; align-items: center; gap: 8px; padding: 6px 0;
                       border-bottom: 1px solid #0f1117; cursor: pointer; }
.net-detail-contact:last-child { border-bottom: none; }
.net-detail-contact:hover .net-detail-name { color: #a78bfa; }
.net-detail-name { font-size: 0.85rem; font-weight: 600; color: #e2e8f0; flex: 1; min-width: 0;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.net-detail-role { font-size: 0.7rem; color: #64748b; }
.net-score-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

/* ---- Conversation search ---- */
#conv-search-results { flex: 1; overflow-y: auto; }
.conv-result { padding: 10px 16px 10px 20px; border-bottom: 1px solid #0f1117;
               cursor: pointer; transition: background 0.1s; }
.conv-result:hover { background: #12172a; }
.conv-result-top { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.conv-contact { font-size: 0.88rem; font-weight: 600; color: #e2e8f0; flex: 1; min-width: 0;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-source { font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 10px; flex-shrink: 0; }
.conv-date { font-size: 0.68rem; color: #4a5568; flex-shrink: 0; }
.conv-snippet { font-size: 0.78rem; color: #64748b; line-height: 1.5; }
.conv-snippet mark { background: #312e81; color: #c4b5fd; border-radius: 2px; padding: 0 2px; }
#conv-search-toggle.active { background: #1e2740; border-color: #4f46e5; color: #a78bfa; }

/* ---- Communities (group chats) view ---- */
#view-groups { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.groups-header { padding: 16px 20px; border-bottom: 1px solid #1e2740; flex-shrink: 0; }
.groups-header h2 { font-size: 1rem; font-weight: 600; margin-bottom: 4px; }
.groups-header p { font-size: 0.8rem; color: #4a5568; }
.groups-body { flex: 1; display: flex; overflow: hidden; }
.groups-list { width: 300px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid #1e2740; }
.group-item { padding: 12px 16px; border-bottom: 1px solid #0f1117; cursor: pointer;
              transition: background 0.1s; }
.group-item:hover { background: #1a1f2e; }
.group-item.active { background: #1e2740; }
.group-item-top { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 4px; }
.group-name { font-size: 0.88rem; font-weight: 600; color: #e2e8f0; flex: 1; min-width: 0;
              white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.group-cat { font-size: 0.62rem; font-weight: 700; padding: 2px 6px; border-radius: 10px;
             text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0; margin-top: 1px; }
.cat-professional { background: #1e3a5f; color: #60a5fa; }
.cat-university   { background: #064e3b; color: #34d399; }
.cat-social       { background: #3b0764; color: #c084fc; }
.cat-personal     { background: #422006; color: #fb923c; }
.cat-other        { background: #1e2740; color: #64748b; }
.group-meta { font-size: 0.72rem; color: #4a5568; display: flex; gap: 8px; margin-bottom: 4px; }
.group-snippet { font-size: 0.75rem; color: #475569; white-space: nowrap;
                 overflow: hidden; text-overflow: ellipsis; }
.groups-detail { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.groups-detail-empty { flex: 1; display: flex; align-items: center; justify-content: center;
                        color: #4a5568; font-size: 0.9rem; }
.group-detail-header { padding: 14px 20px; border-bottom: 1px solid #1e2740; flex-shrink: 0; }
.group-detail-header h3 { font-size: 1rem; font-weight: 700; color: #f1f5f9; margin-bottom: 4px; }
.group-detail-header p { font-size: 0.78rem; color: #4a5568; }

.group-msg-from-link { color: var(--accent-hover); cursor: pointer; }
.group-msg-from-link:hover { color: var(--accent); text-decoration: underline; }
.group-roster {
  padding: 12px 16px; border-top: 1px solid var(--border);
  display: flex; flex-wrap: wrap; gap: 6px;
  background: rgba(99,102,241,0.02);
}
.group-roster-title {
  width: 100%; font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.1em; font-weight: 600; color: var(--text-muted);
  margin-bottom: 4px;
}
.group-roster-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; padding: 4px 10px; border-radius: 12px;
  background: var(--bg-card); border: 1px solid var(--border);
  color: var(--text-secondary); cursor: pointer;
}
.group-roster-chip:hover { border-color: var(--accent); color: var(--text-primary); }
.group-roster-chip-anon { font-style: italic; cursor: default; opacity: 0.7; }

/* @lid labelling panel */
.lid-label-panel {
  margin: 14px 16px; padding: 12px;
  background: rgba(99,102,241,0.06);
  border: 1px solid var(--border); border-radius: 8px;
}
.lid-label-title {
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  margin-bottom: 10px;
}
.lid-label-help { font-weight: 400; color: var(--text-muted); font-size: 11px; }
.lid-label-row {
  display: flex; gap: 8px; align-items: center; margin-bottom: 6px;
}
.lid-label-info { flex: 1; min-width: 0; display: flex; gap: 8px; align-items: center; }
.lid-label-count {
  font-size: 11px; padding: 2px 7px; border-radius: 8px;
  background: rgba(99,102,241,0.15); color: var(--accent-hover);
  font-weight: 600; flex-shrink: 0;
}
.lid-label-sample {
  font-size: 11px; color: var(--text-secondary); font-style: italic;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lid-label-select {
  background: var(--bg-card); border: 1px solid var(--border);
  color: var(--text-secondary); font-size: 11px;
  padding: 4px 6px; border-radius: 6px; min-width: 140px;
  font-family: inherit;
}
.lid-label-select:focus { border-color: var(--accent); outline: 0; }
.lid-label-more { font-size: 11px; color: var(--text-muted); margin: 6px 0; }
.lid-label-save {
  margin-top: 8px; padding: 6px 12px;
  background: var(--accent); color: white; border: 0;
  border-radius: 6px; font-size: 12px; font-weight: 500;
  cursor: pointer; font-family: inherit;
}
.lid-label-save:hover { background: var(--accent-hover); }
.lid-label-save:disabled { opacity: 0.5; cursor: default; }

/* ---- Settings ---- */
.settings-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 10px; padding: 20px; margin-bottom: 16px;
}
.settings-card-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--text-muted); font-weight: 600; margin-bottom: 12px;
}
.settings-row {
  display: flex; align-items: center; gap: 16px;
  padding: 10px 0; border-bottom: 1px solid var(--border);
}
.settings-row:last-child { border-bottom: 0; }
.settings-row-label { font-size: 13px; color: var(--text-secondary); flex-shrink: 0; min-width: 110px; }
.settings-row-value { font-size: 13px; color: var(--text-primary); flex: 1; }
.settings-mode-badge {
  font-size: 11px; font-weight: 600; padding: 3px 10px;
  border-radius: 10px; text-transform: uppercase; letter-spacing: 0.06em;
}
.settings-mode-badge.real { background: rgba(34,197,94,0.15); color: #86efac; }
.settings-mode-badge.demo { background: rgba(168,139,250,0.18); color: #c4b5fd; }
.settings-actions { margin-top: 14px; display: flex; gap: 10px; }
.settings-btn {
  padding: 8px 16px; background: var(--accent); color: white;
  border: 0; border-radius: 8px; font-size: 13px; font-weight: 500;
  cursor: pointer; font-family: inherit;
}
.settings-btn:hover { background: var(--accent-hover); }
.settings-btn-secondary {
  background: transparent; color: var(--text-secondary);
  border: 1px solid var(--border); font-size: 11px; padding: 4px 10px;
}
.settings-btn-secondary:hover { border-color: var(--accent); color: var(--text-primary); }
.settings-note {
  margin: 12px 0; padding: 10px 12px; border-radius: 8px;
  font-size: 12px; color: var(--text-secondary);
}
.settings-note-warn { background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.25); color: #fcd34d; }
.group-detail-body { flex: 1; display: flex; overflow: hidden; gap: 0; }
.group-feed { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.group-msg { background: #1a1f2e; border-radius: 8px; padding: 8px 12px; }
.group-msg-meta { font-size: 0.68rem; color: #4a5568; margin-bottom: 3px;
                   display: flex; gap: 8px; }
.group-msg-from { color: #7c3aed; font-weight: 600; }
.group-msg-body { font-size: 0.82rem; color: #94a3b8; line-height: 1.5; }
.group-signals { width: 260px; flex-shrink: 0; border-left: 1px solid #1e2740;
                  overflow-y: auto; padding: 14px; }
.signal-section { margin-bottom: 16px; }
.signal-title { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.08em; color: #4a5568;
                text-transform: uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.signal-item { font-size: 0.75rem; color: #94a3b8; padding: 5px 0; border-bottom: 1px solid #1a2035;
               line-height: 1.4; }
.signal-item:last-child { border-bottom: none; }
.signal-item a { color: #60a5fa; text-decoration: none; word-break: break-all; }
.signal-item a:hover { text-decoration: underline; }
.signal-date { font-size: 0.65rem; color: #374151; display: block; margin-top: 2px; }
.signals-empty { color: #374151; font-size: 0.75rem; font-style: italic; }

/* ---- Shared ---- */
.loading { text-align: center; padding: 60px 20px; color: #4a5568; }

/* ---- Score chip / override ---- */
.score-chip-wrap { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.score-chip { font-size: 0.72rem; font-weight: 700; padding: 3px 10px; border-radius: 20px;
              background: #12172a; border: 1px solid #1e2740; cursor: default; }
.score-chip.score-strong { background: #064e3b; color: #34d399; border-color: #065f46; }
.score-chip.score-good   { background: #422006; color: #fbbf24; border-color: #78350f; }
.score-chip.score-weak   { background: #431407; color: #f97316; border-color: #7c2d12; }
.score-chip.score-cold   { background: #450a0a; color: #ef4444; border-color: #7f1d1d; }
.score-edit-btn { background: none; border: none; color: #374151; cursor: pointer; font-size: 0.8rem;
                  padding: 2px 4px; border-radius: 4px; }
.score-edit-btn:hover { color: #64748b; background: #1e2740; }
.score-override-panel { display: flex; align-items: center; gap: 6px; background: #1a1f2e;
                         border: 1px solid #2d3748; border-radius: 8px; padding: 6px 10px;
                         font-size: 0.78rem; color: #94a3b8; }

/* ---- Command Palette ---- */
#cmd-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000;
               display: none; align-items: flex-start; justify-content: center; padding-top: 12vh; }
#cmd-overlay.open { display: flex; }
#cmd-palette { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
               width: min(560px, 92vw); max-height: 65vh; display: flex; flex-direction: column;
               box-shadow: 0 24px 60px rgba(0,0,0,0.6); overflow: hidden; }
#cmd-input-wrap { display: flex; align-items: center; gap: 10px; padding: 14px 16px;
                  border-bottom: 1px solid #1e2740; }
#cmd-input-wrap .cmd-icon { color: #4a5568; font-size: 1rem; flex-shrink: 0; }
#cmd-input { flex: 1; background: none; border: none; outline: none; color: #e2e8f0;
             font-size: 1rem; placeholder: ''; }
#cmd-input::placeholder { color: #374151; }
#cmd-results { overflow-y: auto; max-height: 400px; }
.cmd-section { padding: 6px 0 2px; }
.cmd-section-label { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.08em;
                     color: #374151; text-transform: uppercase; padding: 4px 16px; }
.cmd-item { display: flex; align-items: center; gap: 12px; padding: 9px 16px;
            cursor: pointer; transition: background 0.08s; }
.cmd-item:hover, .cmd-item.active { background: #1e2740; }
.cmd-item-icon { width: 28px; height: 28px; border-radius: 7px; background: #12172a;
                 display: flex; align-items: center; justify-content: center;
                 font-size: 0.85rem; flex-shrink: 0; }
.cmd-item-label { font-size: 0.88rem; color: #e2e8f0; font-weight: 500; }
.cmd-item-sub { font-size: 0.72rem; color: #4a5568; margin-left: auto; flex-shrink: 0; }
.cmd-item-badge { font-size: 0.62rem; padding: 2px 6px; border-radius: 10px;
                  background: #12172a; color: #64748b; margin-left: auto; }
#cmd-empty { padding: 24px; text-align: center; color: #4a5568; font-size: 0.85rem; }
.nav-cmd-hint {
  display: flex; align-items: center; justify-content: center;
  padding: 8px 0; width: 100%; background: none; border: none; border-left: 3px solid transparent;
  cursor: pointer; border-radius: 8px; color: var(--text-muted);
}
@media (min-width: 768px) { .nav-cmd-hint { justify-content: flex-start; padding: 8px 10px; } }
.nav-cmd-hint:hover { background: var(--bg-hover); color: var(--text-secondary); }

/* ---- Mobile responsive (< 768px) — bottom tab bar ---- */
.nav-more-btn { display: none; }
#more-sheet-overlay { display: none; }
#more-sheet { display: none; }
@media (min-width: 768px) { .nav-bottom-slot { display: block; padding: 6px 4px 10px; } }
@media (max-width: 767px) {
  body { flex-direction: column; height: 100dvh; }
  nav {
    position: fixed; bottom: 0; left: 0; right: 0;
    width: 100% !important; height: 56px; flex-direction: row;
    border-right: none; border-top: 1px solid var(--border);
    z-index: 200; flex-shrink: 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  #main { padding-bottom: 56px; overflow: hidden; }
  .nav-logo { display: none; }
  #sync-status-bar { display: none; }
  .nav-bottom-slot { display: none; }
  .nav-links { flex-direction: row; padding: 0; align-items: stretch; height: 100%; flex: 1; overflow: hidden; }
  .nav-link {
    flex: 1; flex-direction: column; gap: 2px;
    padding: 6px 4px; border-left: none; border-top: 2px solid transparent;
    justify-content: center; align-items: center; height: 100%; border-radius: 0;
    min-height: 44px; font-size: 10px;
  }
  .nav-link.active { border-left-color: transparent; border-top-color: var(--accent); background: rgba(99,102,241,0.06); }
  .nav-label { display: inline; font-size: 10px; letter-spacing: 0; }
  /* Primary tabs: Today, People, Network — secondary items hidden in bottom bar */
  #nav-ask, #nav-groups, #nav-intros, #nav-sources, #nav-review, #nav-settings, .nav-cmd-hint { display: none; }
  .nav-more-btn { display: flex !important; }
  /* Contact detail: full viewport, prominent back */
  .back-btn { font-size: 1.3rem; padding: 10px 14px; background: var(--bg-card); border-radius: 8px; margin-right: 4px; }
  .contact-hero { padding: 12px 14px; gap: 12px; min-height: auto; }
  .hero-avatar-wrap { width: 64px; height: 64px; }
  .hero-avatar { width: 56px; height: 56px; font-size: 1.1rem; }
  .hero-name { font-size: 17px; }
  .hero-score-num { font-size: 26px; }
  .detail-body { padding: 12px; gap: 12px; }
  .quick-actions { padding: 8px 14px; }
  /* List header: compact */
  .list-header { padding: 10px 14px; }
  /* Today: compact padding */
  .today-scroll { padding: 12px 14px; gap: 16px; }
  /* Ask view */
  .ask-inner { padding: 16px 14px; }
  .ask-hero { padding: 16px 0 12px; }
  .ask-hero h2 { font-size: 1.15rem; }
  .ask-chips { gap: 6px; }
  /* Letter sidebar: hide on mobile */
  .letter-sidebar { display: none !important; }
  /* Sources grid */
  .sources-grid { grid-template-columns: 1fr !important; }
  /* Cmd+K: bottom sheet style on mobile */
  #cmd-overlay { align-items: flex-end; padding-top: 0; }
  #cmd-palette { width: 100%; border-radius: 16px 16px 0 0; max-height: 75vh; }
  /* More sheet */
  #more-sheet-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 300; }
  #more-sheet-overlay.open { display: block; }
  #more-sheet {
    position: fixed; bottom: 56px; left: 0; right: 0;
    background: var(--bg-card); border-top: 1px solid var(--border);
    border-radius: 16px 16px 0 0; z-index: 301; padding: 8px 0 8px;
    transform: translateY(110%); transition: transform 220ms ease;
    display: block !important;
  }
  #more-sheet.open { transform: translateY(0); }
  .more-sheet-handle { width: 36px; height: 4px; background: var(--border); border-radius: 2px; margin: 4px auto 12px; }
  .more-sheet-item {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 22px; cursor: pointer; color: var(--text-secondary); font-size: 0.92rem;
    border: none; background: none; width: 100%; text-align: left; font-family: inherit;
    transition: background 120ms ease;
  }
  .more-sheet-item:active { background: var(--bg-hover); }
  .more-sheet-item.active { color: var(--accent); }
  .more-sheet-item svg { color: inherit; }
  .more-sheet-divider { height: 1px; background: var(--border); margin: 4px 0; }
}

/* Ask view */
#view-ask { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.ask-inner { flex: 1; overflow-y: auto; padding: 32px 28px; max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.ask-hero { text-align: center; padding: 40px 0 32px; }
.ask-hero h2 { font-size: 1.4rem; font-weight: 600; color: var(--text-primary); letter-spacing: -0.03em; margin: 0 0 6px; }
.ask-hero p { font-size: 0.85rem; color: var(--text-secondary); margin: 0; }
.ask-search-wrap { position: relative; margin-bottom: 20px; }
.ask-search-wrap input {
  width: 100%; box-sizing: border-box;
  padding: 16px 20px; font-size: 1rem; color: var(--text-primary);
  background: var(--bg-card); border: 1.5px solid var(--border); border-radius: 12px;
  outline: none; transition: border-color 180ms ease;
}
.ask-search-wrap input:focus { border-color: var(--accent); }
.ask-search-wrap input::placeholder { color: var(--text-muted); }
.ask-send-btn {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
  background: var(--accent); color: #fff; border: none; border-radius: 8px;
  padding: 8px 14px; font-size: 0.8rem; font-weight: 600; cursor: pointer;
  transition: background 180ms ease;
}
.ask-send-btn:hover { background: var(--accent-hover); }
.ask-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 28px; }
.ask-chip {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 20px;
  padding: 6px 14px; font-size: 0.75rem; color: var(--text-secondary); cursor: pointer;
  transition: all 180ms ease;
}
.ask-chip:hover { border-color: var(--accent); color: var(--accent); }
.ask-description { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 16px; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600; }
.ask-results { display: flex; flex-direction: column; gap: 10px; }
.ask-result-card {
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
  padding: 16px; display: flex; gap: 14px; align-items: flex-start; cursor: pointer;
  transition: all 180ms ease;
}
.ask-result-card:hover { border-color: var(--accent); box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
.ask-result-avatar { position: relative; width: 48px; height: 48px; flex-shrink: 0; }
.ask-result-body { flex: 1; min-width: 0; }
.ask-result-name { font-size: 0.95rem; font-weight: 500; color: var(--text-primary); letter-spacing: -0.02em; margin-bottom: 2px; }
.ask-result-role { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 6px; }
.ask-result-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ask-result-tag { font-size: 0.68rem; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); color: var(--text-secondary); }
.ask-result-tag.city { border-color: #1e3a5f; color: #93c5fd; background: rgba(30,58,95,0.3); }
.ask-result-tag.role { border-color: #064e3b; color: #6ee7b7; background: rgba(6,78,59,0.3); }
.ask-result-reason { font-size: 0.8rem; color: var(--text-secondary); font-style: italic; line-height: 1.5; background: rgba(99,102,241,0.06); border-radius: 6px; padding: 8px 10px; }
.ask-result-reasons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.ask-reason-chip {
  font-size: 0.72rem; padding: 3px 8px; border-radius: 10px;
  border: 1px solid var(--border); background: rgba(99,102,241,0.04);
  color: var(--text-secondary);
  display: inline-flex; align-items: center; gap: 4px;
}
.ask-reason-chip.role     { border-color: #064e3b; color: #6ee7b7; background: rgba(6,78,59,0.2); }
.ask-reason-chip.location { border-color: #1e3a5f; color: #93c5fd; background: rgba(30,58,95,0.2); }
.ask-reason-chip.topic    { border-color: #4c1d95; color: #c4b5fd; background: rgba(76,29,149,0.2); }
.ask-reason-chip.keyword  { border-color: #78350f; color: #fcd34d; background: rgba(120,53,15,0.2); }
.ask-reason-chip.warmth   { border-color: #166534; color: #86efac; background: rgba(22,101,52,0.2); }
.ask-reason-chip.recent   { border-color: #9f1239; color: #fda4af; background: rgba(159,18,57,0.2); }
.ask-reason-kind { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; opacity: 0.85; }
.ask-reason-detail { font-size: 0.72rem; color: inherit; opacity: 0.85; }
.ask-result-score { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
.ask-result-score-num { font-size: 1.1rem; font-weight: 700; }
.ask-result-actions { display: flex; gap: 8px; margin-top: 10px; }
.ask-result-actions button { flex: 1; padding: 6px 10px; border-radius: 7px; font-size: 0.72rem; font-weight: 600; cursor: pointer; transition: all 180ms ease; }
.ask-btn-primary { background: var(--accent); color: #fff; border: none; }
.ask-btn-primary:hover { background: var(--accent-hover); }
.ask-btn-secondary { background: none; border: 1px solid var(--border); color: var(--text-secondary); }
.ask-btn-secondary:hover { border-color: var(--accent); color: var(--accent); }
.ask-skeleton { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; height: 100px; margin-bottom: 10px; position: relative; overflow: hidden; }
.ask-skeleton::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.04), transparent); animation: shimmer 1.5s infinite; }
@keyframes shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
.ask-thinking { text-align: center; padding: 12px; font-size: 0.8rem; color: var(--text-muted); font-style: italic; }

/* Sources view */
#view-sources { padding: 32px 28px; overflow-y: auto; }
.sources-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-width: 720px; }
@media (max-width: 700px) { .sources-grid { grid-template-columns: 1fr; } }
.source-card { background: #111827; border: 1px solid #1e2d45; border-radius: 12px; padding: 18px 20px; transition: border-color 180ms ease, box-shadow 180ms ease; }
.source-card:hover { border-color: rgba(99,102,241,0.4); box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
.source-tip { font-size: 0.76rem; color: #4b5563; line-height: 1.65; margin-bottom: 14px; }
.source-tip a { color: #818cf8; text-decoration: none; }
.source-tip a:hover { color: #a5b4fc; text-decoration: underline; }
.source-card-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.source-icon { font-size: 1.2rem; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.05); border-radius: 9px; flex-shrink: 0; }
.source-name { font-size: 0.9rem; font-weight: 600; color: #f0f4ff; letter-spacing: -0.02em; }
.source-meta { font-size: 0.7rem; color: #4b5563; margin-top: 2px; line-height: 1.5; }
.source-status { margin-left: auto; font-size: 0.65rem; font-weight: 600; padding: 3px 8px; border-radius: 20px; letter-spacing: 0.02em; white-space: nowrap; flex-shrink: 0; }
.source-status.connected { color: #34d399; background: rgba(52,211,153,0.1); }
.source-status.pending { color: #fb923c; background: rgba(251,146,60,0.1); }
.source-status.idle { color: #374151; background: rgba(55,65,81,0.2); }
.source-desc { font-size: 0.76rem; color: #4b5563; margin: 0 0 14px; line-height: 1.6; }
.source-form { display: flex; flex-direction: column; gap: 8px; }
.source-form input { background: rgba(10,12,18,0.7); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 9px 12px; color: #e2e8f0; font-size: 0.82rem; outline: none; transition: border-color 0.15s; width: 100%; box-sizing: border-box; }
.source-form input:focus { border-color: rgba(99,102,241,0.6); box-shadow: 0 0 0 3px rgba(99,102,241,0.12); }
.source-form input::placeholder { color: #2d3748; }
.source-btn { background: #6366f1; border: none; border-radius: 8px; padding: 9px 16px; color: #fff; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: background 180ms ease, transform 0.08s; letter-spacing: -0.01em; }
.source-btn:hover { background: #818cf8; }
.source-btn:active { transform: scale(0.98); }
.source-btn:disabled { background: rgba(255,255,255,0.06); color: #374151; cursor: not-allowed; transform: none; }
.source-btn.secondary { background: rgba(255,255,255,0.05); color: #8892a4; border: 1px solid #1e2d45; }
.source-btn.secondary:hover { background: rgba(255,255,255,0.09); color: #f0f4ff; border-color: rgba(99,102,241,0.4); }
.drop-zone { border: 1.5px dashed rgba(255,255,255,0.08); border-radius: 10px; padding: 18px 14px; text-align: center; color: #4b5563; font-size: 0.76rem; cursor: pointer; transition: all 180ms ease; line-height: 1.6; }
.drop-zone:hover, .drop-zone.drag-over { border-color: rgba(99,102,241,0.5); color: #a5b4fc; background: rgba(99,102,241,0.05); }
.drop-zone input[type=file] { display: none; }
.source-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(0,0,0,0.2); border-radius: 8px; gap: 10px; }
.source-row + .source-row { margin-top: 4px; }
.source-qr { text-align: center; margin-top: 12px; }
.source-qr img { border-radius: 12px; max-width: 200px; }
.source-log { font-size: 0.72rem; color: #4b5563; margin-top: 8px; font-family: ui-monospace, monospace; line-height: 1.5; }
/* Sync status dots */
@keyframes syncPulse { 0%,100% { opacity:1; box-shadow:0 0 0 0 rgba(99,102,241,0.4); } 50% { opacity:0.7; box-shadow:0 0 0 4px rgba(99,102,241,0); } }
.sync-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; margin-top:5px; }
.sync-dot-active  { background:#6366f1; animation: syncPulse 1.5s ease infinite; }
.sync-dot-ok      { background:#22c55e; opacity:0.8; }
.sync-dot-stale   { background:#f59e0b; }
.sync-dot-error   { background:#ef4444; }
.sync-dot-idle    { background:#374151; }
/* Sidebar sync status bar */
#sync-status-bar { padding:8px 12px; border-top:1px solid var(--border); cursor:pointer; }
#sync-status-bar:hover { background:rgba(255,255,255,0.03); }

/* ---- Typography system ---- */
.t-name { font-size: 15px; font-weight: 500; letter-spacing: -0.02em; color: var(--text-primary); }
.t-company { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); font-weight: 500; }
.t-time { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.t-section-header { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; color: var(--text-muted); }

/* ---- Card hover system ---- */
.source-card { background: var(--bg-card) !important; border: 1px solid var(--border) !important; border-radius: 12px; }
.source-card:hover { border-color: rgba(99,102,241,0.4) !important; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
.detail-section, .insights-card, .rel-timeline, .digest-summary, .digest-section, .reconnect-card { border-radius: 12px; }

/* ---- Structural color updates ---- */
body { background: var(--bg); }
.list-header, .detail-header, .reconnect-header, .review-header, .groups-header { background: var(--bg); }
.contact-list, .reconnect-list { background: var(--bg); }
.detail-section { background: var(--bg-card); border-color: var(--border); }
.insights-card { background: var(--bg-card); border-color: var(--border); }
.rel-timeline { background: var(--bg-card); border-color: var(--border); }
</style>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>window.__BASE__ = '__BASE__';</script>
</head>
<body>

<div id="notif-banners"></div>

<div id="sync-toast" class="sync-toast" style="display:none" onclick="showView('sources')" role="status" aria-live="polite">
  <span class="sync-toast-spinner" aria-hidden="true"></span>
  <span class="sync-toast-text" id="sync-toast-text">Syncing WhatsApp…</span>
  <div class="sync-toast-bar"><div class="sync-toast-bar-fill" id="sync-toast-fill"></div></div>
</div>

<div id="palette-overlay" class="palette-overlay" role="dialog" aria-modal="true" aria-label="Command palette">
  <div class="palette">
    <div class="palette-input-wrap">
      <svg class="palette-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="5.5"/><path d="M13 13l3 3"/>
      </svg>
      <input id="palette-input" type="text" placeholder="Search people, messages, goals, companies… (⌘K)" autocomplete="off" spellcheck="false" />
      <span class="palette-hint"><kbd>↑↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close</span>
    </div>
    <div id="palette-results" class="palette-results"></div>
  </div>
</div>

<nav>
  <div class="nav-logo">
    <span class="nav-logo-icon" aria-hidden="true">M</span>
    <span class="nav-logo-text">Minty</span>
  </div>
  <div class="nav-links">
    <button class="nav-link active" id="nav-today" onclick="showView('today')" title="Today">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="14" height="13" rx="2"/>
          <path d="M6 1v4M12 1v4M2 8h14"/>
          <path d="M6 12h1M9 12h1M12 12h1"/>
        </svg>
      </span>
      <span class="nav-label">Today</span>
    </button>
    <button class="nav-link" id="nav-contacts" onclick="showView('contacts')" title="People">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="6" r="3"/>
          <path d="M3 17c0-3.314 2.686-6 6-6s6 2.686 6 6"/>
        </svg>
      </span>
      <span class="nav-label">People</span>
    </button>
    <button class="nav-link" id="nav-ask" onclick="showView('ask')" title="Ask">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="5.5"/>
          <path d="M13 13l3 3"/>
          <path d="M6.5 6.5c0-1 .8-1.8 1.5-1.8s1.5.8 1.5 1.5c0 1-1.5 1.5-1.5 2.3"/>
          <circle cx="8" cy="11.5" r="0.5" fill="currentColor"/>
        </svg>
      </span>
      <span class="nav-label">Ask</span>
    </button>
    <button class="nav-link" id="nav-network" onclick="showView('network')" title="Network">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="9" r="2"/>
          <circle cx="3" cy="4" r="1.5"/>
          <circle cx="15" cy="4" r="1.5"/>
          <circle cx="3" cy="14" r="1.5"/>
          <circle cx="15" cy="14" r="1.5"/>
          <line x1="7.6" y1="7.6" x2="4.4" y2="5.4"/>
          <line x1="10.4" y1="7.6" x2="13.6" y2="5.4"/>
          <line x1="7.6" y1="10.4" x2="4.4" y2="12.6"/>
          <line x1="10.4" y1="10.4" x2="13.6" y2="12.6"/>
        </svg>
      </span>
      <span class="nav-label">Network</span>
    </button>
    <button class="nav-link" id="nav-groups" onclick="showView('groups')" title="Communities">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 4a2 2 0 012-2h10a2 2 0 012 2v6a2 2 0 01-2 2H6l-4 3V4z"/>
        </svg>
      </span>
      <span class="nav-label">Communities</span>
    </button>
    <button class="nav-link" id="nav-intros" onclick="showView('intros')" title="Intros">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="3.5" cy="9" r="2.5"/>
          <circle cx="14.5" cy="9" r="2.5"/>
          <path d="M6 9h6"/>
          <path d="M10 7l2 2-2 2"/>
        </svg>
      </span>
      <span class="nav-label">Intros</span>
    </button>
    <button class="nav-link" id="nav-sources" onclick="showView('sources')" title="Sources">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 2L4 10h5l-1 6 7-8h-5l1-6z"/>
        </svg>
      </span>
      <span class="nav-label">Sources</span>
    </button>
    <button class="nav-link" id="nav-review" onclick="showView('review')" title="Review">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="5"/>
          <path d="M13 13l3 3"/>
        </svg>
      </span>
      <span class="nav-label">Review</span>
      <span class="nav-badge" id="review-badge" style="display:none"></span>
    </button>
    <button class="nav-link" id="nav-settings" onclick="showView('settings')" title="Settings">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="9" r="2.5"/>
          <path d="M14.7 11A1.5 1.5 0 0015 9.5l1.1-.9-1-1.7-1.4.4a1.5 1.5 0 00-1.3-.8l-.4-1.4h-2l-.4 1.4a1.5 1.5 0 00-1.3.8l-1.4-.4-1 1.7L4 9.5a1.5 1.5 0 00.3 1.5L3 11.9l1 1.7 1.4-.4a1.5 1.5 0 001.3.8l.4 1.4h2l.4-1.4a1.5 1.5 0 001.3-.8l1.4.4 1-1.7-1.1-.9z"/>
        </svg>
      </span>
      <span class="nav-label">Settings</span>
    </button>
    <button class="nav-cmd-hint" onclick="openPalette()" title="Command palette (⌘K)">
      <span class="nav-icon" style="font-size:0.7rem;color:var(--text-muted)">⌘K</span>
    </button>
    <!-- Mobile-only "More" tab -->
    <button class="nav-link nav-more-btn" id="nav-more" onclick="openMoreSheet()" title="More">
      <span class="nav-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="none">
          <circle cx="4" cy="9" r="1.5" fill="currentColor"/>
          <circle cx="9" cy="9" r="1.5" fill="currentColor"/>
          <circle cx="14" cy="9" r="1.5" fill="currentColor"/>
        </svg>
      </span>
      <span class="nav-label">More</span>
    </button>
  </div>
  <div id="sync-status-bar" onclick="showView('sources')" title="Data sources sync status"></div>
</nav>

<!-- Mobile More sheet (hidden on desktop via CSS) -->
<div id="more-sheet-overlay" onclick="closeMoreSheet()"></div>
<div id="more-sheet">
  <div class="more-sheet-handle"></div>
  <button class="more-sheet-item" id="more-ask" onclick="showView('ask');closeMoreSheet()">
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="8" r="5.5"/><path d="M13 13l3 3"/>
      <path d="M6.5 6.5c0-1 .8-1.8 1.5-1.8s1.5.8 1.5 1.5c0 1-1.5 1.5-1.5 2.3"/>
      <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none"/>
    </svg>
    Ask
  </button>
  <button class="more-sheet-item" id="more-groups" onclick="showView('groups');closeMoreSheet()">
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="6" cy="6" r="2.5"/><circle cx="12" cy="6" r="2.5"/>
      <path d="M1 16c0-2.761 2.239-5 5-5"/><path d="M17 16c0-2.761-2.239-5-5-5"/>
      <path d="M6 11c0-2.761 2.239-5 6-5"/>
    </svg>
    Communities
  </button>
  <button class="more-sheet-item" id="more-intros" onclick="showView('intros');closeMoreSheet()">
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 9h12M3 9l4-4M3 9l4 4M15 9l-4-4M15 9l-4 4" stroke-linecap="round"/>
    </svg>
    Intros
  </button>
  <button class="more-sheet-item" id="more-sources" onclick="showView('sources');closeMoreSheet()">
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 10a4 4 0 01-4 4H6a4 4 0 010-8h1"/><path d="M4 8a4 4 0 014-4h4a4 4 0 014 4v.5"/>
    </svg>
    Sources
  </button>
  <button class="more-sheet-item" id="more-review" onclick="showView('review');closeMoreSheet()">
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 2l2.09 4.26L16 7.27l-3.5 3.41.83 4.82L9 13.18l-4.33 2.32.83-4.82L2 7.27l4.91-.71L9 2z"/>
    </svg>
    Review
  </button>
  <button class="more-sheet-item" id="more-settings" onclick="showView('settings');closeMoreSheet()">
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="9" cy="9" r="2.5"/>
      <path d="M14.7 11A1.5 1.5 0 0015 9.5l1.1-.9-1-1.7-1.4.4a1.5 1.5 0 00-1.3-.8l-.4-1.4h-2l-.4 1.4a1.5 1.5 0 00-1.3.8l-1.4-.4-1 1.7L4 9.5a1.5 1.5 0 00.3 1.5L3 11.9l1 1.7 1.4-.4a1.5 1.5 0 001.3.8l.4 1.4h2l.4-1.4a1.5 1.5 0 001.3-.8l1.4.4 1-1.7-1.1-.9z"/>
    </svg>
    Settings
  </button>
</div>

<!-- Command palette overlay -->
<div id="cmd-overlay" onclick="if(event.target===this)closePalette()">
  <div id="cmd-palette">
    <div id="cmd-input-wrap">
      <span class="cmd-icon">⌘</span>
      <input id="cmd-input" placeholder="Search contacts, views, companies…" autocomplete="off"
             oninput="onCmdInput(this.value)" onkeydown="onCmdKey(event)">
    </div>
    <div id="cmd-results"></div>
  </div>
</div>

<div id="main">

  <!-- Ask: natural language network query -->
  <div id="view-ask" style="display:none">
    <div class="ask-inner">
      <div class="ask-hero">
        <h2>Ask your network</h2>
        <p>Find exactly who you need, ranked by relationship and relevance.</p>
      </div>
      <div class="ask-search-wrap">
        <input type="text" id="ask-input" placeholder="Who do I know in London that is a founder I should meet?"
               onkeydown="if(event.key==='Enter')runAskQuery()" autocomplete="off">
        <button class="ask-send-btn" onclick="runAskQuery()">Ask</button>
      </div>
      <div class="ask-chips">
        <button class="ask-chip" onclick="setAskQuery('who do I know in London that is a founder I should meet')">London founders to meet</button>
        <button class="ask-chip" onclick="setAskQuery('investors I haven\\'t spoken to in 3 months')">Dormant investors</button>
        <button class="ask-chip" onclick="setAskQuery('who at Google should I reconnect with')">Google connections</button>
        <button class="ask-chip" onclick="setAskQuery('fintech people worth meeting in New York')">NYC fintech</button>
      </div>
      <div id="ask-results"></div>
    </div>
  </div>

  <!-- Today: goal-oriented home view -->
  <div id="view-today">
    <div class="today-scroll" id="today-scroll">
      <div class="loading">Loading…</div>
    </div>
  </div>

  <!-- Contact list -->
  <div id="view-contacts" style="display:none">
    <div class="list-header">
      <div class="search-wrap">
        <span class="search-icon">🔎</span>
        <input type="text" id="search-input" placeholder="Search by name, company, phone…" oninput="onSearch(this.value)">
        <button id="conv-search-toggle" onclick="toggleConvSearch()" title="Toggle conversation search"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:1px solid #2d3748;
                 border-radius:5px;color:#4a5568;font-size:0.68rem;padding:2px 7px;cursor:pointer;white-space:nowrap">
          Convos
        </button>
      </div>
      <div id="conv-search-results" style="display:none"></div>
      <div class="source-filters" id="source-filters">
        <button class="sf active" onclick="setSourceFilter('all', this)">All</button>
        <button class="sf" onclick="setSourceFilter('whatsapp', this)">WhatsApp</button>
        <button class="sf" onclick="setSourceFilter('linkedin', this)">LinkedIn</button>
        <button class="sf" onclick="setSourceFilter('googleContacts', this)">Google</button>
        <button class="sf" onclick="setSourceFilter('sms', this)">SMS</button>
        <button class="sf" onclick="setSourceFilter('multi', this)">Multi-source</button>
        <button class="sf" id="sf-uncontacted" onclick="setSourceFilter('uncontacted', this)">Never messaged</button>
      </div>
      <div id="uncontacted-banner" style="display:none;background:#12172a;border:1px solid #1e2740;border-radius:8px;padding:8px 12px;font-size:0.75rem;color:#64748b">
        <span id="uncontacted-count"></span> LinkedIn connections you've never messaged — great cold outreach opportunities
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="list-count" id="list-count"></div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="view-toggle">
            <button class="vt-btn active" id="vt-list" onclick="setViewMode('list')" title="List view">☰</button>
            <button class="vt-btn" id="vt-grid" onclick="setViewMode('grid')" title="Grid view">⊞</button>
          </div>
          <div class="sort-bar">
            <label for="sort-select">Sort</label>
            <select class="sort-select" id="sort-select" onchange="setSort(this.value)">
              <option value="score">Relationship strength</option>
              <option value="recent">Recently contacted</option>
              <option value="attention">Needs attention</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
        </div>
      </div>
    </div>
    <div class="health-bar-wrap" id="health-bar-wrap" style="display:none">
      <div class="health-bar" id="health-bar">
        <div class="health-seg" id="hs-strong" style="background:var(--health-strong)" onclick="setHealthFilter('strong')" title="Strong (score ≥70)"></div>
        <div class="health-seg" id="hs-good"   style="background:var(--health-good)"   onclick="setHealthFilter('good')"   title="Good (score 40–69)"></div>
        <div class="health-seg" id="hs-warm"   style="background:var(--health-warm)"   onclick="setHealthFilter('warm')"   title="Warm (score 20–39)"></div>
        <div class="health-seg" id="hs-fading" style="background:var(--health-fading)" onclick="setHealthFilter('fading')" title="Fading (score 1–19)"></div>
        <div class="health-seg" id="hs-none"   style="background:var(--health-none)"   onclick="setHealthFilter('none')"   title="Never contacted (score 0)"></div>
      </div>
      <div class="health-summary" id="health-summary"></div>
    </div>
    <div class="contact-list-wrap">
      <div class="contact-list" id="contact-list">
        <div class="loading">Loading contacts…</div>
      </div>
      <div class="letter-sidebar" id="letter-sidebar" style="display:none"></div>
    </div>
  </div>

  <!-- Reconnect dashboard -->
  <div id="view-reconnect" style="display:none">
    <div class="reconnect-header">
      <h2>Reconnect</h2>
      <p>Strong relationships going cold — people worth reaching out to this week.</p>
    </div>
    <div class="reconnect-list" id="reconnect-list">
      <div class="loading">Loading…</div>
    </div>
  </div>

  <!-- This Week digest -->
  <div id="view-digest" style="display:none">
    <div class="groups-header">
      <h2>This Week</h2>
      <p>Your weekly network digest — generated by Claude Code from your conversation history.</p>
    </div>
    <div id="digest-body" style="flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px">
      <div class="loading">Loading digest…</div>
    </div>
  </div>

  <!-- Intros -->
  <div id="view-intros" style="display:none">
    <div class="groups-header">
      <h2>Intros</h2>
      <p>Find the warmest path to anyone in your network, or browse pairs who should already know each other.</p>
    </div>
    <div class="intro-finder" style="padding: 14px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0;">
      <div class="intro-finder-wrap">
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary);flex-shrink:0">
          <circle cx="8" cy="8" r="5.5"/><path d="M13 13l3 3"/>
        </svg>
        <input id="intro-find-input" type="text" placeholder="Who do you want to reach? (e.g. 'Hana at Stripe', 'Priya')" />
      </div>
      <div id="intro-find-results" style="margin-top: 12px;"></div>
    </div>
    <div id="intros-list" style="flex:1;overflow-y:auto"><div class="loading">Loading…</div></div>
  </div>

  <!-- Network Map -->
  <div id="view-network" style="display:none">
    <div class="groups-header" style="flex-shrink:0">
      <h2>Network Map</h2>
      <p>Bubble size = contact count · Color = industry · Bubbles cluster by sector</p>
    </div>
    <div style="padding:10px 20px;border-bottom:1px solid #1e2740;flex-shrink:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div class="search-wrap" style="flex:1;min-width:180px">
        <span class="search-icon">🔎</span>
        <input type="text" id="network-search" placeholder="Search company to highlight…" oninput="onNetworkSearch(this.value)"
          style="width:100%;background:#1a1f2e;border:1px solid #2d3748;border-radius:8px;padding:8px 12px 8px 36px;color:#e2e8f0;font-size:0.875rem;outline:none">
      </div>
      <div id="network-legend" style="font-size:0.65rem;color:#4a5568;display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0"></div>
    </div>
    <div id="network-body" style="flex:1;display:flex;overflow:hidden;position:relative">
      <div id="network-graph" style="flex:1;position:relative;overflow:hidden">
        <svg id="network-svg" style="width:100%;height:100%"></svg>
        <div id="network-tooltip" style="position:absolute;background:#1a1f2e;border:1px solid #2d3748;border-radius:8px;padding:10px 14px;pointer-events:none;display:none;max-width:220px;z-index:10"></div>
      </div>
      <div id="network-detail" style="width:270px;flex-shrink:0;border-left:1px solid #1e2740;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px">
        <div style="color:#4a5568;font-size:0.8rem;text-align:center;margin-top:40px">Click a company bubble<br>to see your contacts there</div>
      </div>
    </div>
  </div>

  <!-- Communities (group chats) -->
  <div id="view-groups" style="display:none">
    <div class="groups-header">
      <h2>Communities</h2>
      <p>WhatsApp group chats — communities you're part of, with extracted signals.</p>
    </div>
    <div class="groups-body">
      <div class="groups-list" id="groups-list"><div class="loading">Loading…</div></div>
      <div class="groups-detail" id="groups-detail">
        <div class="groups-detail-empty">Select a community to see messages and signals</div>
      </div>
    </div>
  </div>

  <!-- Sources -->
  <div id="view-sources" style="display:none">
    <div style="margin-bottom:24px;max-width:720px;display:flex;align-items:flex-end;justify-content:space-between;gap:16px">
      <div>
        <h2 style="font-size:1.25rem;font-weight:700;color:#f0f4ff;letter-spacing:-0.025em;margin-bottom:4px">Data Sources</h2>
        <p style="font-size:0.76rem;color:#4b5563;margin:0;line-height:1.5">Connect your accounts — Minty syncs automatically in the background.</p>
      </div>
      <div id="sources-overall-status" style="display:flex;align-items:center;gap:6px;flex-shrink:0"></div>
    </div>
    <div class="sources-grid" id="sources-grid"></div>
  </div>

  <!-- Contact detail -->
  <div id="view-contact" style="display:none"></div>

  <!-- Settings -->
  <div id="view-settings" style="display:none;padding:32px 28px;overflow-y:auto;max-width:720px">
    <h2 style="font-size:1.25rem;font-weight:700;color:var(--text-primary);letter-spacing:-0.025em;margin-bottom:4px">Settings</h2>
    <p style="font-size:0.76rem;color:var(--text-muted);margin-bottom:24px;line-height:1.5">Configure how Minty stores and serves your data.</p>
    <div id="settings-body"><div class="loading">Loading…</div></div>
  </div>

  <!-- Review queue -->
  <div id="view-review" style="display:none">
    <div class="review-header">
      <h2>Match Review</h2>
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" id="r-progress-fill" style="width:0%"></div></div>
        <span class="progress-text" id="r-progress-text">Loading…</span>
      </div>
      <button class="merge-btn" onclick="runMerge()">Run merge.js</button>
    </div>
    <div class="review-body" id="review-body"></div>
  </div>

</div>

<script>
const BASE = window.__BASE__ || '';
// ============================================================
// State
// ============================================================
const PAGE_SIZE = 60; // used for grid mode only
let allContacts = [];
let filteredContacts = [];
let listPage = 0; // grid mode page
let searchQuery = '';
let sourceFilter = 'all';
let sortMode = 'score';
let healthFilter = 'all';
let showUnnamed = false;
let searchTimer = null;
let viewMode = localStorage.getItem('crm-view-mode') || 'list';
let kbCursor = -1;

// Virtual scroll state
let vsScrollHandler = null; // current scroll listener fn (or null)

// Review state
let reviewItems = [];
let reviewCurrent = 0;
let reviewDecisions = {};

// Today / Goals state
let todayGoals = [];
let activeGoalId = null;
let todayData = null;
let todayLoaded = false;

// Staleness state — loaded once at startup, used to decorate contact rows
let staleSources = new Set(); // Set of source names (e.g. 'linkedin', 'whatsapp') that are stale

// ============================================================
// Startup
// ============================================================
let syncToastPoller = null;
let syncToastLastDoneAt = 0;
let syncToastLastDoneSource = null;
const SOURCE_LABELS = {
  whatsapp: 'WhatsApp', linkedin: 'LinkedIn', telegram: 'Telegram',
  email: 'Email', sms: 'SMS', googleContacts: 'Google Contacts', apollo: 'Apollo',
};
function labelForSource(key) { return SOURCE_LABELS[key] || key; }

async function pollNotifications() {
  const host = document.getElementById('notif-banners');
  if (!host) return;
  let notifs = {};
  try {
    const r = await fetch(BASE + '/api/notifications');
    if (!r.ok) return;
    const data = await r.json();
    notifs = (data && data.notifications) || {};
  } catch { return; }

  const keys = Object.keys(notifs);
  if (keys.length === 0) { host.innerHTML = ''; return; }

  host.innerHTML = keys.map(key => {
    const n = notifs[key] || {};
    const label = labelForSource(key);
    const msg = esc(n.message || (label + ' needs attention.'));
    const target = key === 'whatsapp' ? "showView('sources')" : '';
    return \`
      <div class="notif-banner" role="alert">
        <span class="notif-banner-text">
          <span class="notif-banner-source">\${esc(label)}:</span>\${msg}
        </span>
        \${target ? \`<button class="notif-banner-action" onclick="\${target}">Open Sources</button>\` : ''}
        <button class="notif-banner-action" onclick="dismissNotification('\${esc(key)}')">I've re-authed</button>
        <button class="notif-banner-dismiss" aria-label="Dismiss" onclick="dismissNotification('\${esc(key)}')">×</button>
      </div>
    \`;
  }).join('');
}

async function dismissNotification(key) {
  try {
    await fetch(BASE + '/api/notifications/' + encodeURIComponent(key) + '/dismiss', { method: 'POST' });
  } catch { /* ignore */ }
  pollNotifications();
}

async function pollSyncToast() {
  const toast = document.getElementById('sync-toast');
  const text = document.getElementById('sync-toast-text');
  const fill = document.getElementById('sync-toast-fill');
  if (!toast || !text || !fill) return;
  let li = null, wa = null;
  try {
    const r = await fetch(BASE + '/api/sync/progress');
    if (!r.ok) return;
    const data = await r.json();
    const toast = document.getElementById('sync-toast');
    const text = document.getElementById('sync-toast-text');
    const fill = document.getElementById('sync-toast-fill');
    if (!toast || !text || !fill) return;

    const active = data.active || {};
    const activeKeys = Object.keys(active);

    if (activeKeys.length > 0) {
      // Prefer WhatsApp (live, real-time) first, else the oldest-started
      activeKeys.sort((a, b) => {
        if (a === 'whatsapp') return -1;
        if (b === 'whatsapp') return 1;
        return (active[a].startedAt || '').localeCompare(active[b].startedAt || '');
      });
      const key = activeKeys[0];
      const p = active[key];
      toast.style.display = 'flex';
      toast.classList.remove('success');
      let label = 'Syncing ' + labelForSource(key) + '…';
      let pct = p.percent;
      if (typeof pct !== 'number' && p.total > 0) pct = Math.round((p.current / p.total) * 100);
      if (pct != null && p.total) {
        const msgCount = p.messageCount ? p.messageCount.toLocaleString() + ' msgs · ' : '';
        label = 'Syncing ' + labelForSource(key) + ' · ' + p.current + '/' + p.total + ' · ' + msgCount + pct + '%';
        fill.style.width = pct + '%';
      } else if (p.step === 'init' || p.step === 'contacts') {
        fill.style.width = '5%';
        if (p.message) label = labelForSource(key) + ' — ' + p.message;
      } else if (p.message) {
        fill.style.width = '10%';
        label = labelForSource(key) + ' — ' + p.message;
      }
      if (activeKeys.length > 1) label += ' · +' + (activeKeys.length - 1) + ' more';
      text.textContent = label;
      return;
    }

    // No active sources — show a "just finished" success toast for ~8s
    const all = data.all || {};
    let lastDone = null, lastDoneKey = null;
    for (const [k, p] of Object.entries(all)) {
      if (p.step === 'done' && p.updatedAt) {
        if (!lastDone || (p.updatedAt > lastDone.updatedAt)) { lastDone = p; lastDoneKey = k; }
      }
    }
    const within = (stamp) => stamp && (Date.now() - new Date(stamp).getTime() < 8000);
    if (lastDone && within(lastDone.updatedAt) && lastDoneKey !== syncToastLastDoneSource) {
      syncToastLastDoneAt = Date.now();
      syncToastLastDoneSource = lastDoneKey;
      toast.classList.add('success');
      toast.style.display = 'flex';
      text.textContent = lastDone.message || (labelForSource(lastDoneKey) + ' sync complete');
      fill.style.width = '100%';
      setTimeout(() => {
        toast.style.display = 'none';
        toast.classList.remove('success');
        syncToastLastDoneSource = null;
      }, 8000);
      return;
    }
    if (toast.classList.contains('success') && Date.now() - syncToastLastDoneAt > 8000) {
      toast.style.display = 'none';
      toast.classList.remove('success');
    } else if (!toast.classList.contains('success')) {
      toast.style.display = 'none';
    }
  } catch {}
  // Active LinkedIn wins (opt-in, rarer), then active WhatsApp, then any "just-done" state.
  const active = (li && li.active && li) || (wa && wa.active && wa);
  if (active) {
    toast.style.display = 'flex';
    toast.classList.remove('success');
    text.textContent = active.label;
    fill.style.width = (active.pct != null ? active.pct : 10) + '%';
    return;
  }
  // Show LinkedIn done for 8s after completion, same for WhatsApp.
  if (li && li.done && Date.now() - syncToastLiLastDone < 8000) {
    toast.classList.add('success'); toast.style.display = 'flex';
    text.textContent = li.label || 'LinkedIn sync complete'; fill.style.width = '100%'; return;
  }
  if (li && li.done && !syncToastLiLastDone) {
    syncToastLiLastDone = Date.now();
    toast.classList.add('success'); toast.style.display = 'flex';
    text.textContent = li.label || 'LinkedIn sync complete'; fill.style.width = '100%';
    setTimeout(() => { toast.style.display = 'none'; }, 8000);
    return;
  }
  if (wa && wa.done && Date.now() - syncToastLastDoneAt < 8000) {
    toast.classList.add('success'); toast.style.display = 'flex';
    text.textContent = wa.label || 'WhatsApp sync complete'; fill.style.width = '100%'; return;
  }
  if (wa && wa.done && !syncToastLastDoneAt) {
    syncToastLastDoneAt = Date.now();
    toast.classList.add('success'); toast.style.display = 'flex';
    text.textContent = wa.label || 'WhatsApp sync complete'; fill.style.width = '100%';
    setTimeout(() => { toast.style.display = 'none'; }, 8000);
    return;
  }
  toast.style.display = 'none';
}

// ============================================================
// Command palette (Cmd/Ctrl+K)
// ============================================================
let paletteResults = [];
let paletteActiveIdx = 0;
let paletteDebounce = null;

function openPalette() {
  const o = document.getElementById('palette-overlay');
  if (!o) return;
  o.classList.add('open');
  const input = document.getElementById('palette-input');
  input.value = '';
  paletteActiveIdx = 0;
  paletteQuery('');
  setTimeout(() => { input.focus(); input.select(); }, 10);
}

function closePalette() {
  document.getElementById('palette-overlay')?.classList.remove('open');
}

async function paletteQuery(q) {
  try {
    const r = await fetch(BASE + '/api/palette?q=' + encodeURIComponent(q));
    if (!r.ok) return;
    const data = await r.json();
    paletteResults = data.results || [];
    paletteActiveIdx = 0;
    renderPalette();
  } catch {}
}

function renderPalette() {
  const el = document.getElementById('palette-results');
  if (!el) return;
  if (paletteResults.length === 0) {
    el.innerHTML = '<div class="palette-empty">No matches yet — try a name, company, or message snippet.</div>';
    return;
  }
  // Group by type for display
  const order = ['contact', 'conversation', 'goal', 'company', 'nav'];
  const labels = { contact: 'People', conversation: 'In conversations', goal: 'Goals', company: 'Companies', nav: 'Go to' };
  const groups = {};
  paletteResults.forEach((r, i) => {
    if (!groups[r.type]) groups[r.type] = [];
    groups[r.type].push({ ...r, _idx: i });
  });
  const parts = [];
  for (const key of order) {
    if (!groups[key]) continue;
    parts.push('<div class="palette-group"><div class="palette-group-label">' + labels[key] + '</div>');
    for (const r of groups[key]) {
      parts.push(paletteItemHtml(r));
    }
    parts.push('</div>');
  }
  el.innerHTML = parts.join('');
  paletteUpdateActive();
}

function paletteItemHtml(r) {
  const active = r._idx === paletteActiveIdx ? ' active' : '';
  const badge = r.type.charAt(0).toUpperCase() + r.type.slice(1);
  const initials = (r.label || '?').split(/\\s+/).slice(0,2).map(s => s.charAt(0).toUpperCase()).join('');
  const ring = r.type === 'contact' ? '<span class="palette-score-ring ' + tierFor(r.relationshipScore) + '"></span>' : '';
  const avatar = r.type === 'contact' ? '<div class="palette-item-avatar">' + escapeHtml(initials) + '</div>' : '<div class="palette-item-avatar" style="background:linear-gradient(135deg,#1e2d45,#4b5563)">·</div>';
  return '<div class="palette-item' + active + '" data-idx="' + r._idx + '" onclick="paletteSelect(' + r._idx + ')">'
    + avatar
    + ring
    + '<div class="palette-item-body">'
    + '<div class="palette-item-title">' + escapeHtml(r.label || '') + '</div>'
    + (r.sublabel ? '<div class="palette-item-sub">' + escapeHtml(r.sublabel) + '</div>' : '')
    + '</div>'
    + '<span class="palette-item-type">' + badge + '</span>'
    + '</div>';
}

function tierFor(score) {
  if (score == null) return 'none';
  if (score >= 70) return 'strong';
  if (score >= 40) return 'good';
  if (score >= 20) return 'warm';
  if (score > 0)   return 'fading';
  return 'none';
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function paletteUpdateActive() {
  document.querySelectorAll('.palette-item').forEach(el => {
    el.classList.toggle('active', Number(el.getAttribute('data-idx')) === paletteActiveIdx);
  });
  const active = document.querySelector('.palette-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function paletteSelect(idx) {
  const r = paletteResults[idx];
  if (!r) return;
  closePalette();
  if (r.type === 'nav') { showView(r.action); return; }
  if (r.type === 'contact') { showContact(r.id); return; }
  if (r.type === 'conversation') {
    if (r.contactId) showContact(r.contactId);
    return;
  }
  if (r.type === 'goal') {
    showView('today');
    return;
  }
  if (r.type === 'company') {
    // Jump to Ask prefilled with "at <company>"
    showView('ask');
    const input = document.getElementById('ask-input');
    if (input) { input.value = 'at ' + r.name; input.focus(); }
    return;
  }
}

document.addEventListener('keydown', (e) => {
  const isOpen = document.getElementById('palette-overlay')?.classList.contains('open');
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault(); isOpen ? closePalette() : openPalette(); return;
  }
  if (!isOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (paletteResults.length === 0) return;
    paletteActiveIdx = (paletteActiveIdx + 1) % paletteResults.length;
    paletteUpdateActive(); return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (paletteResults.length === 0) return;
    paletteActiveIdx = (paletteActiveIdx - 1 + paletteResults.length) % paletteResults.length;
    paletteUpdateActive(); return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    paletteSelect(paletteActiveIdx); return;
  }
});

document.addEventListener('click', (e) => {
  const overlay = document.getElementById('palette-overlay');
  if (!overlay?.classList.contains('open')) return;
  if (e.target === overlay) closePalette();
});

function wirePaletteInput() {
  const input = document.getElementById('palette-input');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(paletteDebounce);
    const q = input.value;
    paletteDebounce = setTimeout(() => paletteQuery(q), 80);
  });
}

async function init() {
  // Show Today immediately — contacts load in background
  showView('today');
  wirePaletteInput();
  // Start global sync toast poller (runs regardless of view)
  if (!syncToastPoller) {
    pollSyncToast();
    syncToastPoller = setInterval(pollSyncToast, 2000);
  }
  // Notification banners (re-auth, etc.) — poll every 30s
  pollNotifications();
  setInterval(pollNotifications, 30 * 1000);

  // Load contacts in background and populate People view when ready
  const listEl = document.getElementById('contact-list');
  fetch(BASE + '/api/contacts').then(async res => {
    if (!res.ok) {
      if (listEl) listEl.innerHTML = '<div class="loading" style="color:#ef4444">Failed to load contacts.</div>';
      return;
    }
    allContacts = await res.json();
    try {
      updateHealthStats();
      applyFilter();
    } catch (e) {
      if (listEl) listEl.innerHTML = '<div class="loading" style="color:#ef4444">Render error: ' + e.message + '</div>';
    }
    loadReviewCount();
  }).catch(e => {
    if (listEl) listEl.innerHTML = '<div class="loading" style="color:#ef4444">Failed to load contacts: ' + e.message + '</div>';
  });

  // Load staleness + sync status in background
  fetch(BASE + '/api/sync/status').then(r => r.json()).then(data => {
    syncStatuses = data;
    updateSyncStatusBar();
  }).catch(() => {});
  fetch(BASE + '/api/staleness').then(r => r.json()).then(data => {
    const allStale = [
      ...(data.staleSources || []).map(s => s.source),
      ...(data.warnings || []).map(w => w.source),
    ];
    staleSources = new Set(allStale);
  }).catch(() => {});
}

function updateHealthStats() {
  const named = allContacts.filter(c => c.name && !c.isGroup);
  const strong = named.filter(c => (c.relationshipScore||0) >= 70);
  const good   = named.filter(c => (c.relationshipScore||0) >= 40 && (c.relationshipScore||0) < 70);
  const warm   = named.filter(c => (c.relationshipScore||0) >= 20 && (c.relationshipScore||0) < 40);
  const fading = named.filter(c => (c.relationshipScore||0) >  0  && (c.relationshipScore||0) < 20);
  const none   = named.filter(c => (c.relationshipScore||0) === 0);
  const total  = named.length;

  const wrap = document.getElementById('health-bar-wrap');
  if (wrap) wrap.style.display = '';

  const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0%';
  const setW = (id, n) => { const el = document.getElementById(id); if (el) el.style.width = pct(n); };
  setW('hs-strong', strong.length);
  setW('hs-good',   good.length);
  setW('hs-warm',   warm.length);
  setW('hs-fading', fading.length);
  setW('hs-none',   none.length);

  const summaryEl = document.getElementById('health-summary');
  if (summaryEl) {
    const stats = [
      { label: 'strong',  count: strong.length, filter: 'strong',  color: 'var(--health-strong)'  },
      { label: 'good',    count: good.length,   filter: 'good',    color: 'var(--health-good)'    },
      { label: 'warm',    count: warm.length,   filter: 'warm',    color: 'var(--health-warm)'    },
      { label: 'fading',  count: fading.length, filter: 'fading',  color: 'var(--health-fading)'  },
      { label: 'never',   count: none.length,   filter: 'none',    color: 'var(--health-none)'    },
    ];
    summaryEl.innerHTML = stats.map((s, i) =>
      (i > 0 ? '<span style="color:var(--text-muted);margin:0 2px">·</span>' : '') +
      \`<span class="health-stat\${healthFilter === s.filter ? ' hs-active' : ''}" onclick="setHealthFilter('\${s.filter}')" style="color:\${s.color}">\${s.count.toLocaleString()} \${s.label}</span>\`
    ).join('');
  }
}

function setHealthFilter(f) {
  healthFilter = f;
  // Update bar segment active state
  ['strong','good','warm','fading','none'].forEach(k => {
    const el = document.getElementById('hs-' + k);
    if (el) el.classList.toggle('hs-active', k === f);
  });
  // Refresh summary active states
  document.querySelectorAll('.health-stat').forEach(el => {
    el.classList.toggle('hs-active', el.getAttribute('onclick') === \`setHealthFilter('\${f}')\`);
  });
  applyFilter();
}

// ============================================================
// Navigation
// ============================================================
function showView(view) {
  document.getElementById('view-ask').style.display       = view === 'ask'       ? 'flex' : 'none';
  document.getElementById('view-today').style.display     = view === 'today'     ? 'flex' : 'none';
  document.getElementById('view-contacts').style.display  = view === 'contacts'  ? 'flex' : 'none';
  document.getElementById('view-contact').style.display   = view === 'contact'   ? 'flex' : 'none';
  document.getElementById('view-reconnect').style.display = view === 'reconnect' ? 'flex' : 'none';
  document.getElementById('view-digest').style.display    = view === 'digest'    ? 'flex' : 'none';
  document.getElementById('view-groups').style.display    = view === 'groups'    ? 'flex' : 'none';
  document.getElementById('view-network').style.display   = view === 'network'   ? 'flex' : 'none';
  document.getElementById('view-intros').style.display    = view === 'intros'    ? 'flex' : 'none';
  document.getElementById('view-review').style.display    = view === 'review'    ? 'flex' : 'none';
  document.getElementById('view-sources').style.display   = view === 'sources'   ? 'block' : 'none';
  const settingsView = document.getElementById('view-settings');
  if (settingsView) settingsView.style.display = view === 'settings' ? 'block' : 'none';
  // Close more sheet if open
  closeMoreSheet();
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.more-sheet-item').forEach(el => el.classList.remove('active'));
  // Secondary views: mark "More" tab active on mobile
  const moreViews = ['ask', 'groups', 'intros', 'sources', 'review', 'settings'];
  if (moreViews.includes(view)) {
    document.getElementById('nav-more')?.classList.add('active');
    const moreItem = document.getElementById(\`more-\${view}\`);
    if (moreItem) moreItem.classList.add('active');
  }
  const navId = view === 'contact' ? 'nav-contacts' : \`nav-\${view}\`;
  document.getElementById(navId)?.classList.add('active');
  if (view === 'today')     loadToday();
  if (view === 'review')    loadReview();
  if (view === 'reconnect') loadReconnect();
  if (view === 'groups')    loadGroups();
  if (view === 'digest')    loadDigest();
  if (view === 'network')   loadNetwork();
  if (view === 'intros')    loadIntros();
  if (view === 'settings')  loadSettings();
  if (view === 'sources') {
    loadSources();
    if (!sourcesRefreshTimer) {
      sourcesRefreshTimer = setInterval(loadSources, 30000);
    }
  } else {
    if (sourcesRefreshTimer) { clearInterval(sourcesRefreshTimer); sourcesRefreshTimer = null; }
  }
}

function openMoreSheet() {
  document.getElementById('more-sheet-overlay')?.classList.add('open');
  document.getElementById('more-sheet')?.classList.add('open');
}
function closeMoreSheet() {
  document.getElementById('more-sheet-overlay')?.classList.remove('open');
  document.getElementById('more-sheet')?.classList.remove('open');
}

// ============================================================
// Today view — goal-oriented home
// ============================================================

async function loadToday() {
  const el = document.getElementById('today-scroll');
  if (!el) return;

  // Load goals and today data in parallel
  try {
    const [goalsData, todayRes] = await Promise.all([
      fetch(BASE + '/api/goals').then(r => r.json()),
      fetch(BASE + '/api/today').then(r => r.json()),
    ]);
    todayGoals = goalsData || [];
    todayData  = todayRes;
    todayLoaded = true;
    renderToday(el);
  } catch (e) {
    el.innerHTML = \`<div class="loading" style="color:#ef4444">Failed to load: \${e.message}</div>\`;
  }
}

function renderMeetingCard(meeting) {
  const timeStr = meeting.startAt ? new Date(meeting.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const knownAttendees = (meeting.attendees || []).filter(a => a.contactId && !a.self);
  const selfAttendee   = (meeting.attendees || []).find(a => a.self);

  // Render known attendee avatars (up to 3)
  const avatarHtml = knownAttendees.slice(0, 3).map(a => {
    const col = avatarColor(a.contactId);
    const ring = healthRingHTML(a.relationshipScore || 0, 36);
    return \`<div style="position:relative;width:36px;height:36px;flex-shrink:0;cursor:pointer"
        onclick="event.stopPropagation();openContact('\${a.contactId}')">
      \${ring}
      <div style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;
                  justify-content:center;font-size:0.68rem;font-weight:600;position:absolute;
                  top:3px;left:3px;background:\${col.bg};color:\${col.fg}">
        \${esc(getInitials(a.name || a.email || '?'))}
      </div>
    </div>\`;
  }).join('');

  // Attendee names
  const attendeeNames = knownAttendees.slice(0, 3).map(a => esc(a.name || a.email || '')).join(', ');
  const extraCount = (meeting.attendees || []).length - 3;

  // Meeting brief from first known attendee with insights
  const withBrief = knownAttendees.find(a => a.meetingBrief);
  const briefHtml = withBrief
    ? \`<div class="today-card-why">\${esc(withBrief.meetingBrief.slice(0, 120))}</div>\`
    : '';

  return \`<div class="today-card meeting-card">
    <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;align-items:center">
      <span style="font-size:0.75rem;color:var(--accent);font-weight:600;font-variant-numeric:tabular-nums">\${esc(timeStr)}</span>
      \${meeting.location ? \`<span style="font-size:0.65rem;color:var(--text-muted)">📍</span>\` : ''}
    </div>
    <div class="today-card-body">
      <div class="today-card-name">\${esc(meeting.title)}</div>
      \${attendeeNames ? \`<div class="today-card-role">\${attendeeNames}\${extraCount > 0 ? \` +\${extraCount} more\` : ''}</div>\` : ''}
      \${briefHtml}
      \${knownAttendees.length > 0 ? \`<div style="display:flex;gap:6px;margin-top:8px">\${avatarHtml}</div>\` : ''}
    </div>
  </div>\`;
}

function renderToday(el) {
  if (!el) return;
  const goals     = todayGoals;
  const sections  = (todayData && todayData.goalSections)     || [];
  const pulse     = (todayData && todayData.pulse)            || [];
  const meetings  = (todayData && todayData.upcomingMeetings) || [];
  const syncWarnings = (todayData && todayData.syncWarnings)  || [];

  // Filter displayed sections by active goal chip
  const visibleSections = activeGoalId
    ? sections.filter(s => s.goalId === activeGoalId)
    : sections;

  let html = '';

  // ---- Sync warning banners (primary sources: WhatsApp / Gmail) ----
  syncWarnings.forEach(w => {
    const severity = w.severity || 'warning';
    html += \`<div class="sync-warn-banner \${severity}" onclick="showView('sources')" title="Go to Sources to fix">
      <svg class="sync-warn-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M7 1l6 11H1L7 1z"/><path d="M7 6v3M7 10.5v.5"/>
      </svg>
      <span>\${esc(w.message)}</span>
    </div>\`;
  });

  // ---- Goals strip ----
  html += '<div class="today-section"><div class="goals-strip">';
  goals.filter(g => g.active !== false).forEach(g => {
    const isActive = activeGoalId === g.id;
    html += \`<span class="goal-chip\${isActive ? ' active' : ''}" onclick="setActiveGoal('\${g.id}')">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="6" cy="6" r="4"/><circle cx="6" cy="6" r="2"/>
      </svg>
      \${esc(g.text)}
      <button class="goal-chip-remove" onclick="event.stopPropagation();removeGoal('\${g.id}')" title="Remove goal">×</button>
    </span>\`;
  });
  html += \`<button class="goal-add-btn" id="goal-add-btn" onclick="showGoalInput()">
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M6 2v8M2 6h8"/>
    </svg>
    Add goal
  </button>\`;
  html += \`<div class="goal-input-wrap" id="goal-input-wrap" style="display:none">
    <input class="goal-input" id="goal-input-field" placeholder="e.g. Raise seed round" maxlength="80"
      onkeydown="onGoalInputKey(event)" />
    <button class="btn-reconnect" onclick="saveNewGoal()">Add</button>
    <button class="btn-reconnect" onclick="hideGoalInput()">Cancel</button>
  </div>\`;
  html += '</div></div>';

  // ---- Goal sections ----
  if (goals.filter(g => g.active !== false).length === 0) {
    html += \`<div class="today-empty">
      <div class="today-empty-icon">🎯</div>
      <div class="today-empty-title">What are you working on?</div>
      <div class="today-empty-sub">Add a goal above — like "Raise seed round" or "Hire a CTO"<br>
      Minty will surface the right people from your network to help.</div>
    </div>\`;
  } else {
    visibleSections.forEach(section => {
      const goal = todayGoals.find(g => g.id === section.goalId);
      const stages = (goal && goal.stages) || ['To reach out', 'Contacted', 'Meeting', 'Intro made', 'Closed'];
      const assignments = (goal && goal.assignments) || {};
      // Quick per-goal pipeline summary: counts per stage
      const counts = stages.map(s => Object.values(assignments).filter(a => (a && a.stage) === s).length);
      const totalInPipeline = counts.reduce((n, x) => n + x, 0);

      html += \`<div class="today-section">
        <div class="today-section-header">
          <span>\${esc(section.goalText)}</span>
          \${totalInPipeline > 0 ? '<span class="goal-pipeline-summary">' + counts.map((n, i) => '<span class="goal-stage-pill" title="' + esc(stages[i]) + '"><span class="goal-stage-dot s' + i + '"></span>' + n + '</span>').join('') + '</span>' : ''}
        </div>\`;

      if (!section.contacts || section.contacts.length === 0) {
        html += \`<div class="today-empty">
          <div class="today-empty-sub">No matching contacts found for this goal.<br>
          Try refining the goal text or adding more keywords.</div>
        </div>\`;
      } else {
        section.contacts.forEach(c => {
          const col = avatarColor(c.id);
          const ring = healthRingHTML(c.relationshipScore || 0, 50);
          const roleStr = [c.position, c.company].filter(Boolean).join(' · ');
          const daysStr = c.daysSinceContact != null
            ? (c.daysSinceContact === 0 ? 'today' : c.daysSinceContact + 'd ago')
            : 'never';
          const topicsHtml = (c.topics || []).slice(0, 3).map(t =>
            \`<span class="today-card-topic">\${esc(t)}</span>\`).join('');
          // Why relevant: meeting brief or fallback
          const whyHtml = c.meetingBrief
            ? \`<div class="today-card-why">\${esc(c.meetingBrief.slice(0, 120))}</div>\`
            : '';

          const assigned = assignments[c.id] && assignments[c.id].stage ? assignments[c.id].stage : null;
          const stageOptions = ['<option value="">— set stage —</option>']
            .concat(stages.map(s => '<option value="' + esc(s) + '"' + (s === assigned ? ' selected' : '') + '>' + esc(s) + '</option>'))
            .join('');
          const stageIdx = stages.indexOf(assigned);
          const stageChip = assigned
            ? '<span class="goal-stage-pill active"><span class="goal-stage-dot s' + stageIdx + '"></span>' + esc(assigned) + '</span>'
            : '';

          html += \`<div class="today-card">
            <div class="today-card-avatar" onclick="openContact('\${c.id}')">
              \${ring}
              <div class="today-card-avatar-inner" style="background:\${col.bg};color:\${col.fg}">
                \${esc(getInitials(c.name))}
              </div>
            </div>
            <div class="today-card-body" onclick="openContact('\${c.id}')" style="cursor:pointer">
              <div class="today-card-name">\${esc(c.name)}</div>
              \${roleStr ? \`<div class="today-card-role">\${esc(roleStr)}</div>\` : ''}
              \${whyHtml}
              <div class="today-card-meta">
                <span class="today-card-score">Score <span>\${c.relationshipScore}</span></span>
                <span class="today-card-days">Last contact: \${daysStr}</span>
                \${stageChip}
              </div>
              \${topicsHtml ? \`<div class="today-card-topics">\${topicsHtml}</div>\` : ''}
              <div class="today-card-stage-row">
                <select class="today-card-stage-select" data-goal-id="\${esc(section.goalId)}" data-contact-id="\${esc(c.id)}" onchange="onStageChange(event)">\${stageOptions}</select>
              </div>
            </div>
          </div>\`;
        });
      }
      html += '</div>';
    });

    // If a goal filter is active and no sections shown
    if (activeGoalId && visibleSections.length === 0) {
      html += \`<div class="today-empty">
        <div class="today-empty-sub">No contacts found for this goal yet.</div>
      </div>\`;
    }
  }

  // ---- Today's meetings ----
  if (meetings.length > 0 && !activeGoalId) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayMeetings = meetings.filter(m => m.startAt && m.startAt.slice(0, 10) === todayStr);
    const tomorrowMeetings = meetings.filter(m => m.startAt && m.startAt.slice(0, 10) !== todayStr);

    if (todayMeetings.length > 0) {
      html += \`<div class="today-section"><div class="today-section-header">Today's meetings</div>\`;
      todayMeetings.forEach(m => { html += renderMeetingCard(m); });
      html += '</div>';
    }
    if (tomorrowMeetings.length > 0) {
      html += '<div class="today-section"><div class="today-section-header">Tomorrow</div>';
      tomorrowMeetings.forEach(m => { html += renderMeetingCard(m); });
      html += '</div>';
    }
  }

  // ---- Recent changes in your network (life events) ----
  if (Array.isArray(todayData?.lifeEvents) && todayData.lifeEvents.length > 0 && !activeGoalId) {
    html += '<div class="today-section"><div class="today-section-header">Recent in your network</div>';
    todayData.lifeEvents.slice(0, 6).forEach(e => {
      const icon = eventIcon(e.kind);
      const col = avatarColor(e.contactId);
      const initials = esc(getInitials(e.contactName || '?'));
      html += \`<div class="pulse-item" onclick="openContact('\${esc(e.contactId)}')">
        <div style="position:relative;width:36px;height:36px;flex-shrink:0">
          <div style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;
                      justify-content:center;font-size:0.72rem;font-weight:600;background:\${col.bg};color:\${col.fg}">
            \${initials}
          </div>
          <span class="life-event-badge" title="\${esc(e.label || e.kind)}">\${icon}</span>
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
          <span class="pulse-item-name">\${esc(e.contactName || '?')}</span>
          <span class="pulse-item-meta" style="font-size:0.74rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(e.label || '')}\${e.snippet ? ' · ' + esc(e.snippet) : ''}</span>
        </div>
      </div>\`;
    });
    html += '</div>';
  }

  // ---- Network pulse (strong contacts) ----
  if (pulse.length > 0 && !activeGoalId) {
    html += '<div class="today-section"><div class="today-section-header">Strong connections</div>';
    pulse.forEach(c => {
      const col = avatarColor(c.id);
      const ring = healthRingHTML(c.relationshipScore || 0, 36);
      const daysStr = c.daysSinceContact != null
        ? (c.daysSinceContact === 0 ? 'today' : c.daysSinceContact + 'd ago')
        : 'never';
      html += \`<div class="pulse-item" onclick="openContact('\${c.id}')">
        <div style="position:relative;width:36px;height:36px;flex-shrink:0">
          \${ring}
          <div style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;
                      justify-content:center;font-size:0.72rem;font-weight:600;
                      position:absolute;top:3px;left:3px;background:\${col.bg};color:\${col.fg}">
            \${esc(getInitials(c.name))}
          </div>
        </div>
        <span class="pulse-item-name">\${esc(c.name)}</span>
        \${c.company ? \`<span class="pulse-item-meta">\${esc(c.company)}</span>\` : ''}
        <span class="pulse-item-meta">\${daysStr}</span>
      </div>\`;
    });
    html += '</div>';
  }

  el.innerHTML = html;
}

function eventIcon(kind) {
  const map = {
    job_change: '💼', funding: '💰', milestone: '🚀',
    life_moment: '✨', birthday: '🎂', reconnection: '👋',
  };
  return map[kind] || '•';
}

// Small SVG health ring — radius adapts to size
function healthRingHTML(score, wrapSize) {
  const padding = 3;
  const r = (wrapSize / 2) - padding;
  const C = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score || 0));
  const offset = C * (1 - pct / 100);
  const tier = score >= 70 ? 'strong' : score >= 40 ? 'good' : score >= 20 ? 'warm' : score > 0 ? 'fading' : 'none';
  const color = {
    strong:'#22c55e', good:'#84cc16', warm:'#f59e0b',
    fading:'#f97316', none:'#374151'
  }[tier];
  return \`<svg width="\${wrapSize}" height="\${wrapSize}" style="position:absolute;top:0;left:0;transform:rotate(-90deg)">
    <circle cx="\${wrapSize/2}" cy="\${wrapSize/2}" r="\${r}" fill="none" stroke="#1e2d45" stroke-width="2.5"/>
    \${pct > 0 ? \`<circle cx="\${wrapSize/2}" cy="\${wrapSize/2}" r="\${r}" fill="none" stroke="\${color}"
      stroke-width="2.5" stroke-dasharray="\${C.toFixed(1)}" stroke-dashoffset="\${offset.toFixed(1)}"
      stroke-linecap="round"/>\` : ''}
  </svg>\`;
}

function setActiveGoal(id) {
  activeGoalId = (activeGoalId === id) ? null : id; // toggle
  const el = document.getElementById('today-scroll');
  if (el && todayLoaded) renderToday(el);
}

async function onStageChange(e) {
  const sel = e.target;
  const goalId = sel.dataset.goalId;
  const contactId = sel.dataset.contactId;
  const stage = sel.value || null;
  try {
    await fetch(BASE + '/api/goals/' + encodeURIComponent(goalId) + '/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, stage }),
    });
    // Refresh goals + re-render today to update pipeline summary
    const goals = await fetch(BASE + '/api/goals').then(r => r.json());
    todayGoals = goals;
    const el = document.getElementById('today-scroll');
    if (el && todayLoaded) renderToday(el);
  } catch (err) {
    console.error('stage update failed:', err);
  }
}

function showGoalInput() {
  document.getElementById('goal-add-btn').style.display = 'none';
  const wrap = document.getElementById('goal-input-wrap');
  if (wrap) { wrap.style.display = 'flex'; wrap.querySelector('input')?.focus(); }
}

function hideGoalInput() {
  const btn = document.getElementById('goal-add-btn');
  if (btn) btn.style.display = '';
  const wrap = document.getElementById('goal-input-wrap');
  if (wrap) { wrap.style.display = 'none'; const inp = wrap.querySelector('input'); if (inp) inp.value = ''; }
}

function onGoalInputKey(e) {
  if (e.key === 'Enter') saveNewGoal();
  if (e.key === 'Escape') hideGoalInput();
}

async function saveNewGoal() {
  const inp = document.getElementById('goal-input-field');
  const text = (inp ? inp.value : '').trim();
  if (!text) return;
  hideGoalInput();
  const newGoal = { text, active: true };
  const updated = await fetch(BASE + '/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newGoal),
  }).then(r => r.json());
  todayGoals = updated;
  // Re-fetch today data since new goal may surface new contacts
  const todayRes = await fetch(BASE + '/api/today').then(r => r.json());
  todayData = todayRes;
  const el = document.getElementById('today-scroll');
  if (el) renderToday(el);
}

async function removeGoal(goalId) {
  const updated = todayGoals
    .filter(g => g.id !== goalId)
    .map(g => ({ ...g }));
  const saved = await fetch(BASE + '/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  }).then(r => r.json());
  todayGoals = saved;
  if (activeGoalId === goalId) activeGoalId = null;
  // Re-fetch today
  const todayRes = await fetch(BASE + '/api/today').then(r => r.json());
  todayData = todayRes;
  const el = document.getElementById('today-scroll');
  if (el) renderToday(el);
}

// ============================================================
// Contact list
// ============================================================
function seniorityScore(position) {
  if (!position) return 0;
  const p = position.toLowerCase();
  if (p.includes('ceo') || p.includes('founder') || p.includes('co-founder') || p.includes('managing director') || p.includes('president')) return 5;
  if (p.includes('cto') || p.includes('coo') || p.includes('cfo') || p.includes('chief')) return 4;
  if (p.includes('vp ') || p.includes('vice president') || p.includes('partner') || p.includes('principal')) return 3;
  if (p.includes('director') || p.includes('head of') || p.includes('lead')) return 2;
  if (p.includes('manager') || p.includes('senior') || p.includes('sr.')) return 1;
  return 0;
}

function applyFilter() {
  const q = searchQuery.toLowerCase();
  const uncontacted = sourceFilter === 'uncontacted';

  // Show/hide uncontacted banner
  const banner = document.getElementById('uncontacted-banner');
  if (banner) banner.style.display = uncontacted ? 'block' : 'none';

  filteredContacts = allContacts.filter(c => {
    if (uncontacted) {
      // Show only named contacts with 0 interactions
      return c.name && (c.interactionCount || 0) === 0;
    }
    if (sourceFilter !== 'all' && sourceFilter !== 'multi') {
      if (!c.sources.includes(sourceFilter)) return false;
    }
    if (sourceFilter === 'multi' && c.sources.length < 2) return false;
    // Health filter
    if (healthFilter === 'strong' && (c.relationshipScore||0) < 70) return false;
    if (healthFilter === 'good'   && !((c.relationshipScore||0) >= 40 && (c.relationshipScore||0) < 70)) return false;
    if (healthFilter === 'warm'   && !((c.relationshipScore||0) >= 20 && (c.relationshipScore||0) < 40)) return false;
    if (healthFilter === 'fading' && !((c.relationshipScore||0) >  0  && (c.relationshipScore||0) < 20)) return false;
    if (healthFilter === 'none'   && (c.relationshipScore||0) > 0) return false;
    if (healthFilter === 'risk'   && !((c.relationshipScore||0) >= 50 && (c.daysSinceContact??999) >= 60)) return false;
    if (healthFilter === 'cold'   && (c.relationshipScore||0) >= 20) return false;
    // When searching, always include unnamed (user is searching by phone etc.)
    if (!showUnnamed && !q && !c.name) return false;
    if (!q) return true;
    return (
      (c.name || '').toLowerCase().includes(q) ||
      (c.company || '').toLowerCase().includes(q) ||
      (c.position || '').toLowerCase().includes(q) ||
      (c.phones || []).some(p => p.includes(q)) ||
      (c.emails || []).some(e => e.toLowerCase().includes(q))
    );
  });

  // Update uncontacted banner count
  if (uncontacted && banner) {
    document.getElementById('uncontacted-count').textContent = filteredContacts.length;
  }

  // Sort
  if (uncontacted) {
    // Sort uncontacted by seniority then A-Z
    filteredContacts.sort((a, b) => {
      const sd = seniorityScore(b.position) - seniorityScore(a.position);
      if (sd !== 0) return sd;
      return (a.name || '').localeCompare(b.name || '');
    });
  } else if (sortMode === 'score') {
    filteredContacts.sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0));
  } else if (sortMode === 'recent') {
    filteredContacts.sort((a, b) => {
      if (!a.lastContactedAt) return 1;
      if (!b.lastContactedAt) return -1;
      return new Date(b.lastContactedAt) - new Date(a.lastContactedAt);
    });
  } else if (sortMode === 'attention') {
    // High score but dormant (score>=50, >60d since contact) — most overdue first
    filteredContacts.sort((a, b) => {
      const aAt = a.relationshipScore >= 50 && (a.daysSinceContact ?? 999) > 60;
      const bAt = b.relationshipScore >= 50 && (b.daysSinceContact ?? 999) > 60;
      if (aAt && !bAt) return -1;
      if (!aAt && bAt) return 1;
      return ((b.relationshipScore || 0) * (b.daysSinceContact || 0)) -
             ((a.relationshipScore || 0) * (a.daysSinceContact || 0));
    });
  } else if (sortMode === 'name') {
    filteredContacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  listPage = 0;
  kbCursor = -1;
  renderList();
}

let convSearchMode = false;

function toggleConvSearch() {
  convSearchMode = !convSearchMode;
  const btn = document.getElementById('conv-search-toggle');
  const convResults = document.getElementById('conv-search-results');
  const contactList = document.getElementById('contact-list');
  const sourceFilters = document.getElementById('source-filters');
  const healthBarWrap = document.getElementById('health-bar-wrap');

  if (convSearchMode) {
    btn.classList.add('active');
    document.getElementById('search-input').placeholder = 'Search conversations…';
    contactList.style.display = 'none';
    convResults.style.display = 'flex';
    convResults.style.flexDirection = 'column';
    sourceFilters.style.display = 'none';
    if (healthBarWrap) healthBarWrap.style.display = 'none';
  } else {
    btn.classList.remove('active');
    document.getElementById('search-input').placeholder = 'Search by name, company, phone…';
    contactList.style.display = '';
    convResults.style.display = 'none';
    sourceFilters.style.display = '';
    if (healthBarWrap) healthBarWrap.style.display = '';
  }
  document.getElementById('search-input').value = '';
  searchQuery = '';
  if (!convSearchMode) applyFilter();
  else convResults.innerHTML = '<div class="loading" style="padding:20px;color:#4a5568">Type to search across all conversations…</div>';
}

function onSearch(val) {
  clearTimeout(searchTimer);
  if (convSearchMode) {
    searchTimer = setTimeout(() => runConvSearch(val), 300);
  } else {
    searchTimer = setTimeout(() => { searchQuery = val; applyFilter(); }, 150);
  }
}

const srcColors = { whatsapp:'#34d399', linkedin:'#60a5fa', email:'#facc15', sms:'#c084fc', telegram:'#38bdf8' };

async function runConvSearch(q) {
  const el = document.getElementById('conv-search-results');
  if (q.length < 2) {
    el.innerHTML = '<div class="loading" style="padding:20px;color:#4a5568">Type to search across all conversations…</div>';
    return;
  }
  el.innerHTML = '<div class="loading">Searching…</div>';
  const d = await fetch(\`\${BASE}/api/search/interactions?q=\${encodeURIComponent(q)}\`).then(r => r.json());

  if (!d.results.length) {
    el.innerHTML = \`<div class="empty-state">No conversations found for "\${esc(q)}"</div>\`;
    return;
  }

  const rows = d.results.map(r => {
    const color = srcColors[r.source] || '#94a3b8';
    const date = r.timestamp ? new Date(r.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' }) : '';
    const raw = r.snippet || '';
    const before = esc(raw.slice(0, r.matchStart));
    const match = esc(raw.slice(r.matchStart, r.matchStart + r.matchLen));
    const after = esc(raw.slice(r.matchStart + r.matchLen));
    const name = r.contactName || r.chatName || '(unknown)';
    const onclick = r.contactId ? \`openContact('\${esc(r.contactId)}')\` : '';
    return \`<div class="conv-result" \${onclick ? \`onclick="\${onclick}"\` : ''}>
      <div class="conv-result-top">
        <span class="conv-contact">\${esc(name)}</span>
        <span class="conv-source" style="background:\${color}20;color:\${color}">\${esc(r.source)}</span>
        <span class="conv-date">\${date}</span>
      </div>
      <div class="conv-snippet">\${before}<mark>\${match}</mark>\${after}</div>
    </div>\`;
  }).join('');

  el.innerHTML = \`<div style="padding:8px 16px;font-size:0.72rem;color:#4a5568;border-bottom:1px solid #0f1117">
    \${d.total} result\${d.total === 1 ? '' : 's'} for "\${esc(q)}"
  </div>\` + rows;
}

function setSourceFilter(f, btn) {
  sourceFilter = f;
  document.querySelectorAll('.sf').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  applyFilter();
}

function setSort(val) {
  sortMode = val;
  applyFilter();
}

function setViewMode(mode) {
  viewMode = mode;
  kbCursor = -1;
  localStorage.setItem('crm-view-mode', mode);
  document.getElementById('vt-list').classList.toggle('active', mode === 'list');
  document.getElementById('vt-grid').classList.toggle('active', mode === 'grid');
  renderList();
}

function computeLiveScore(c) {
  // Apply mild decay based on days since last contact (0.5% per day, min 30% of original)
  const base = c.relationshipScore || 0;
  if (!base) return 0;
  const days = c.daysSinceContact ?? 0;
  const decayed = base * Math.pow(0.995, days);
  return Math.max(Math.round(decayed), Math.round(base * 0.3));
}

function scoreClass(c) {
  const s = computeLiveScore(c);
  return s >= 70 ? 'score-strong'
       : s >= 40 ? 'score-good'
       : s >= 20 ? 'score-weak'
       : s > 0   ? 'score-cold'
       : '';
}

// ============================================================
// Health ring helpers (browser-side; mirrors crm/utils.js)
// ============================================================
function ringColor(score) {
  return score >= 70 ? 'var(--health-strong)'
       : score >= 40 ? 'var(--health-good)'
       : score >= 20 ? 'var(--health-warm)'
       : score >  0  ? 'var(--health-fading)'
       : 'var(--health-none)';
}
function healthRing(liveScore) {
  const R = 21, C = 131.95;
  const pct = Math.max(0, Math.min(100, liveScore || 0));
  const color = ringColor(pct);
  const offset = (C * (1 - pct / 100)).toFixed(1);
  return \`<svg width="50" height="50" viewBox="0 0 50 50" style="position:absolute;top:0;left:0;pointer-events:none;transform:rotate(-90deg)" aria-hidden="true">
    <circle r="\${R}" cx="25" cy="25" fill="none" stroke="\${color}" stroke-width="2" stroke-opacity="0.2"/>
    \${pct > 0 ? \`<circle r="\${R}" cx="25" cy="25" fill="none" stroke="\${color}" stroke-width="2.5" stroke-dasharray="\${C}" stroke-dashoffset="\${offset}" stroke-linecap="round"/>\` : ''}
  </svg>\`;
}

// ============================================================
// Empty state messages
// ============================================================
function getEmptyState() {
  if (searchQuery) {
    return \`<div style="font-size:1rem;font-weight:600;color:var(--text-secondary);margin-bottom:8px">No results for "\${esc(searchQuery)}"</div><div style="font-size:0.82rem;color:var(--text-muted)">Try a company name, job title, or phone number.</div>\`;
  }
  if (sourceFilter === 'uncontacted') {
    return \`<div style="font-size:1rem;font-weight:600;color:var(--text-secondary);margin-bottom:8px">All caught up.</div><div style="font-size:0.82rem;color:var(--text-muted)">No uncontacted connections match this filter.</div>\`;
  }
  if (healthFilter === 'strong') {
    return \`<div style="font-size:1rem;font-weight:600;color:var(--health-strong);margin-bottom:8px">All strong connections recently touched.</div><div style="font-size:0.82rem;color:var(--text-muted)">Nice work. Keep it up.</div>\`;
  }
  return \`<div style="font-size:1rem;font-weight:600;color:var(--text-secondary);margin-bottom:8px">No contacts found.</div><div style="font-size:0.82rem;color:var(--text-muted)">Adjust your filters or import more contacts.</div>\`;
}

// ============================================================
// Contact row HTML builder (shared by list & grid)
// ============================================================
function buildListRow(c, idx) {
  const initials = getInitials(c.name);
  const color = avatarColor(c.id);
  const liveScore = computeLiveScore(c);
  const company = c.company || c.position || '';
  const dots = (c.sources || []).slice(0, 3).map(s => \`<div class="dot dot-\${s}" title="\${s}"></div>\`).join('');
  // Staleness indicator: only for contacts with actual interactions whose source is stale
  const hasInteractions = (c.interactionCount || 0) > 0;
  const contactIsStale = hasInteractions && (c.sources || []).some(s => staleSources.has(s));
  const staleIcon = contactIsStale
    ? \`<span class="dot-stale" title="Data from this contact's source may be outdated">⚠</span>\`
    : '';
  const lastContact = c.daysSinceContact !== null && c.daysSinceContact !== undefined
    ? fmtDaysAgo(c.daysSinceContact)
    : '<span style="color:var(--health-none)">never</span>';
  const kbClass = kbCursor === idx ? ' kb-cursor' : '';
  return \`<div class="contact-item\${kbClass}" data-kb="\${idx}" onclick="openContact('\${esc(c.id)}')">
    <div class="avatar-wrap">
      \${healthRing(liveScore)}
      <div class="avatar" style="background:\${color.bg};color:\${color.fg}">\${esc(initials)}</div>
    </div>
    <div class="contact-info">
      <div class="contact-name">\${esc(c.name || '(no name)')}</div>
      \${company ? \`<div class="contact-company">\${esc(company)}</div>\` : ''}
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
      <div class="source-dots">\${dots}\${staleIcon}</div>
      <div class="last-contact">\${lastContact}</div>
    </div>
  </div>\`;
}

function buildGridCard(c, idx) {
  const initials = getInitials(c.name);
  const color = avatarColor(c.id);
  const sc = scoreClass(c);
  const lastContact = fmtDaysAgo(c.daysSinceContact);
  const sub = c.company || c.position || '';
  const kbClass = kbCursor === idx ? ' kb-cursor' : '';
  return \`<div class="contact-card \${sc}\${kbClass}" data-kb="\${idx}" onclick="openContact('\${esc(c.id)}')">
    <div class="avatar" style="background:\${color.bg};color:\${color.fg};width:44px;height:44px;font-size:1rem">\${esc(initials)}</div>
    <div class="card-name">\${esc(c.name || '(no name)')}</div>
    \${sub ? \`<div class="card-sub">\${esc(sub)}</div>\` : ''}
    \${lastContact ? \`<div class="card-last">\${lastContact}</div>\` : ''}
  </div>\`;
}

// ============================================================
// Virtual scroll (list mode only)
// ============================================================
const VS_ROW_H = 64;
const VS_BUFFER = 5;

function vsRender(listEl) {
  const topPad = document.getElementById('vs-top-pad');
  const rowsEl  = document.getElementById('vs-rows');
  const botPad  = document.getElementById('vs-bot-pad');
  if (!topPad || !rowsEl || !botPad) return;

  const scrollTop  = listEl.scrollTop;
  const containerH = listEl.clientHeight || 700;
  const total      = filteredContacts.length;

  const startIdx = Math.max(0, Math.floor(scrollTop / VS_ROW_H) - VS_BUFFER);
  const endIdx   = Math.min(total, Math.ceil((scrollTop + containerH) / VS_ROW_H) + VS_BUFFER);

  topPad.style.height = (startIdx * VS_ROW_H) + 'px';
  botPad.style.height = Math.max(0, (total - endIdx) * VS_ROW_H) + 'px';
  rowsEl.innerHTML = filteredContacts.slice(startIdx, endIdx)
    .map((c, i) => buildListRow(c, startIdx + i)).join('');
}

function attachVsScroll(listEl) {
  if (vsScrollHandler) {
    listEl.removeEventListener('scroll', vsScrollHandler);
  }
  let raf = null;
  vsScrollHandler = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; vsRender(listEl); });
  };
  listEl.addEventListener('scroll', vsScrollHandler, { passive: true });
}

function detachVsScroll(listEl) {
  if (vsScrollHandler && listEl) {
    listEl.removeEventListener('scroll', vsScrollHandler);
  }
  vsScrollHandler = null;
}

// Move keyboard cursor into view without full re-render
function scrollToCursor() {
  const listEl = document.getElementById('contact-list');
  if (!listEl || viewMode !== 'list') return;
  const containerH  = listEl.clientHeight || 700;
  const scrollTop   = listEl.scrollTop;
  const cursorTop   = kbCursor * VS_ROW_H;
  const cursorBot   = cursorTop + VS_ROW_H;

  if (cursorTop < scrollTop) {
    listEl.scrollTop = cursorTop;
    vsRender(listEl);
  } else if (cursorBot > scrollTop + containerH) {
    listEl.scrollTop = cursorBot - containerH;
    vsRender(listEl);
  }
  // Update cursor class on rendered element
  document.querySelectorAll('.kb-cursor').forEach(e => e.classList.remove('kb-cursor'));
  const el = document.querySelector(\`[data-kb="\${kbCursor}"]\`);
  if (el) el.classList.add('kb-cursor');
  else vsRender(listEl);
}

// ============================================================
// renderList — main entry point
// ============================================================
function renderList() {
  const el = document.getElementById('contact-list');

  // Update count label
  const unnamedCount = allContacts.filter(c => !c.name).length;
  const namedCount   = allContacts.length - unnamedCount;
  const visibleBase  = showUnnamed ? allContacts.length : namedCount;
  const countEl = document.getElementById('list-count');
  let countText = filteredContacts.length < visibleBase
    ? \`\${filteredContacts.length.toLocaleString()} of \${visibleBase.toLocaleString()} contacts\`
    : \`\${filteredContacts.length.toLocaleString()} contacts\`;
  if (!showUnnamed && unnamedCount > 0 && !searchQuery) {
    countText += \` <button onclick="toggleUnnamed()" style="margin-left:6px;background:none;border:none;color:#4a5568;font-size:0.72rem;cursor:pointer;text-decoration:underline">+ \${unnamedCount.toLocaleString()} unnamed</button>\`;
  } else if (showUnnamed && unnamedCount > 0 && !searchQuery) {
    countText += \` <button onclick="toggleUnnamed()" style="margin-left:6px;background:none;border:none;color:#4a5568;font-size:0.72rem;cursor:pointer;text-decoration:underline">hide unnamed</button>\`;
  }
  countEl.innerHTML = countText;

  // Sync view toggle buttons
  document.getElementById('vt-list')?.classList.toggle('active', viewMode === 'list');
  document.getElementById('vt-grid')?.classList.toggle('active', viewMode === 'grid');

  if (filteredContacts.length === 0) {
    detachVsScroll(el);
    el.className = 'contact-list';
    el.innerHTML = \`<div class="empty-state">\${getEmptyState()}</div>\`;
    renderLetterSidebar([]);
    return;
  }

  if (viewMode === 'grid') {
    detachVsScroll(el);
    el.className = 'contact-grid';
    const shown   = filteredContacts.slice(0, (listPage + 1) * PAGE_SIZE);
    const hasMore = filteredContacts.length > shown.length;
    el.innerHTML  = shown.map((c, i) => buildGridCard(c, i)).join('') +
      (hasMore ? \`<div class="load-more"><button onclick="loadMore()">Load more (\${filteredContacts.length - shown.length} remaining)</button></div>\` : '');
    renderLetterSidebar(filteredContacts);
    return;
  }

  // List mode — virtual scroll
  el.className = 'contact-list';
  el.scrollTop = 0;
  el.innerHTML = '<div id="vs-top-pad" style="height:0"></div><div id="vs-rows"></div><div id="vs-bot-pad" style="height:0"></div>';
  attachVsScroll(el);
  vsRender(el);
  renderLetterSidebar(filteredContacts);
}

function renderLetterSidebar(contacts) {
  const sidebar = document.getElementById('letter-sidebar');
  if (!sidebar) return;
  if (sortMode !== 'name' || contacts.length === 0) {
    sidebar.style.display = 'none';
    return;
  }
  sidebar.style.display = 'flex';
  const letters = [...new Set(contacts.map(c => (c.name || '#')[0].toUpperCase()))];
  sidebar.innerHTML = letters.map(l =>
    \`<button class="letter-btn" onclick="jumpToLetter('\${l}')">\${l}</button>\`
  ).join('');
}

function jumpToLetter(letter) {
  const idx = filteredContacts.findIndex(c => (c.name || '#')[0].toUpperCase() === letter);
  if (idx < 0) return;
  if (viewMode === 'list') {
    const listEl = document.getElementById('contact-list');
    if (listEl) { listEl.scrollTop = idx * VS_ROW_H; vsRender(listEl); }
  } else {
    document.querySelector(\`[data-kb="\${idx}"]\`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function loadMore() { listPage++; renderList(); }
function toggleUnnamed() { showUnnamed = !showUnnamed; applyFilter(); }

// ============================================================
// Contact detail
// ============================================================
async function openContact(id) {
  showView('contact');
  const el = document.getElementById('view-contact');
  el.innerHTML = '<div class="loading">Loading…</div>';

  const contact = await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(id)}\`).then(r => r.json());
  renderContactDetail(contact);
}

function renderContactDetail(c) {
  const el = document.getElementById('view-contact');
  const initials = getInitials(c.name);
  const color = avatarColor(c.id);

  // WhatsApp-sourced enrichment: about text + cached profile pic.
  const waSrc = c.sources?.whatsapp || {};
  const waAbout = waSrc.about || null;
  const waPicId = waSrc.id || null;
  const waPicUrl = waPicId && waSrc.profilePic
    ? \`\${BASE}/api/wa-pic/\${encodeURIComponent(waPicId)}\`
    : null;

  // Parse score override from notes
  const overrideMatch = (c.notes || '').match(/score_override:(\d+)/);
  const overrideScore = overrideMatch ? parseInt(overrideMatch[1]) : null;
  const liveScore = overrideScore ?? computeLiveScore(c);
  const baseScore = c.relationshipScore || 0;

  const company  = c.sources.linkedin?.company || c.sources.googleContacts?.org || '';
  const position = c.sources.linkedin?.position || c.sources.googleContacts?.title || '';
  const roleStr  = [position, company].filter(Boolean).join(' at ');

  // Health ring for 80px avatar (r=36, circ~226)
  const CIRC = 2 * Math.PI * 36;
  const ringColor = liveScore >= 70 ? 'var(--health-strong)' : liveScore >= 40 ? 'var(--health-warm)' :
                    liveScore >= 20 ? 'var(--health-fading)' : liveScore > 0 ? 'var(--health-cold)' : 'var(--health-none)';
  const ringOffset = CIRC * (1 - liveScore / 100);
  const ringHtml = \`<svg class="hero-ring-svg" width="80" height="80" viewBox="0 0 80 80">
    <circle class="hero-ring-track" cx="40" cy="40" r="36" stroke-dasharray="\${CIRC.toFixed(1)} \${CIRC.toFixed(1)}"/>
    <circle class="hero-ring-fill" cx="40" cy="40" r="36" stroke="\${ringColor}"
            stroke-dasharray="\${CIRC.toFixed(1)} \${CIRC.toFixed(1)}"
            stroke-dashoffset="\${ringOffset.toFixed(1)}"/>
  </svg>\`;

  const scoreColor = ringColor;
  const barPct = Math.round(liveScore);

  // Last contact line
  const daysStr = c.daysSinceContact != null
    ? (c.daysSinceContact === 0 ? 'today' : c.daysSinceContact + 'd ago')
    : 'never';
  const lastChannel = (c.activeChannels || [])[0] || '';
  const lastContactStr = lastChannel ? daysStr + ' via ' + sourceLabel(lastChannel) : daysStr;

  // Source dots
  const SRC_COLORS = { whatsapp:'#34d399', linkedin:'#60a5fa', email:'#facc15', sms:'#c084fc', telegram:'#38bdf8', googleContacts:'#fb923c' };
  const activeSources = Object.keys(c.sources || {}).filter(k => c.sources[k]);
  const dotsHtml = activeSources.map(s =>
    \`<div class="hero-source-dot" style="background:\${SRC_COLORS[s]||'#8892a4'}" title="\${sourceLabel(s)}"></div>\`
  ).join('');

  // LinkedIn URL for quick action
  const linkedinUrl = c.sources?.linkedin?.profileUrl || '';

  // Info rows
  const infoRows = [];
  if (c.phones?.length)  infoRows.push(['Phone', c.phones.join(', ')]);
  if (c.emails?.length)  infoRows.push(['Email', c.emails.join(', ')]);
  if (c.apollo?.location) infoRows.push(['Location', c.apollo.location]);
  if (company)           infoRows.push(['Company', company]);
  if (position)          infoRows.push(['Role', position]);
  if (c.sources.linkedin?.connectedOn) infoRows.push(['Connected', c.sources.linkedin.connectedOn]);
  if (linkedinUrl)       infoRows.push(['LinkedIn', \`<a href="\${esc(linkedinUrl)}" target="_blank">Open \u2197</a>\`]);
  if (c.apollo?.twitterUrl) infoRows.push(['Twitter', \`<a href="\${esc(c.apollo.twitterUrl)}" target="_blank">Open \u2197</a>\`]);
  if (c.apollo?.headline)   infoRows.push(['Headline', c.apollo.headline]);

  const infoHtml = infoRows.map(([l, v]) =>
    \`<div class="info-label">\${esc(l)}</div><div class="info-value">\${v.startsWith('<') ? v : esc(v)}</div>\`
  ).join('');

  // Employment history from Apollo
  let apolloHtml = '';
  if (c.apollo?.employmentHistory?.length) {
    const jobs = c.apollo.employmentHistory.map(e => {
      const period = [e.startDate, e.endDate || (e.current ? 'present' : '')].filter(Boolean).join('\u2013');
      return \`<div style="margin-bottom:8px;font-size:0.82rem">
        <div style="color:var(--text-primary);font-weight:600">\${esc(e.title || '')} <span style="color:var(--text-muted)">@ \${esc(e.company || '')}</span></div>
        <div style="color:var(--text-muted);font-size:0.75rem">\${esc(period)}</div>
      </div>\`;
    }).join('');
    apolloHtml = \`<div class="detail-section"><h3>Employment History</h3>\${jobs}</div>\`;
  }

  // Score override label indicator
  const scoreLabel = 'Score' + (overrideScore ? ' \u270e' : '');

  el.innerHTML = \`
    <div class="contact-hero">
      <button class="back-btn" onclick="showView('contacts')">\u2190</button>
      <div class="hero-avatar-wrap">
        \${waPicUrl
          ? \`<img class="hero-avatar" src="\${esc(waPicUrl)}" alt="\${esc(c.name || '')}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
             <div class="hero-avatar" style="display:none;background:\${color.bg};color:\${color.fg}">\${esc(initials)}</div>\`
          : \`<div class="hero-avatar" style="background:\${color.bg};color:\${color.fg}">\${esc(initials)}</div>\`}
        \${ringHtml}
      </div>
      <div class="hero-info">
        <div class="hero-name">\${esc(c.name || '(no name)')}</div>
        \${roleStr ? \`<div class="hero-role">\${esc(roleStr)}</div>\` : ''}
        \${waAbout ? \`<div class="hero-role" style="font-style:italic;opacity:0.8">"\${esc(waAbout)}"</div>\` : ''}
        <div class="hero-known" id="hero-known"></div>
      </div>
      <div class="hero-score-col">
        <div>
          <div class="hero-score-num" style="color:\${scoreColor}">\${liveScore}</div>
          <div class="hero-score-label">\${scoreLabel}</div>
        </div>
        <div class="hero-score-bar"><div class="hero-score-fill" style="width:\${barPct}%;background:\${scoreColor}"></div></div>
        <div class="hero-last-contact">\${esc(lastContactStr)}</div>
        \${renderEngagementChips(c.metrics)}
        <div class="hero-source-dots">\${dotsHtml}</div>
      </div>
    </div>
    <div class="quick-actions">
      <button class="qa-btn" onclick="copyName('\${jsAttr(c.name || '')}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy name
      </button>
      \${linkedinUrl ? \`<button class="qa-btn" onclick="window.open('\${esc(linkedinUrl)}','_blank')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>
        LinkedIn
      </button>\` : ''}
      <button class="qa-btn" onclick="openDraftPanel('\${jsAttr(c.id)}','\${jsAttr(c.name || '')}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Draft message
      </button>
      <button class="qa-btn" onclick="toggleScoreOverride('\${jsAttr(c.id)}', \${baseScore}, \${overrideScore ?? liveScore})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
        Edit score
      </button>
      <div id="score-override-panel" style="display:none;align-items:center;gap:8px;flex-wrap:wrap">
        <input type="range" min="0" max="100" value="\${overrideScore ?? liveScore}" id="score-slider"
               oninput="document.getElementById('score-slider-val').textContent=this.value" style="width:100px">
        <span id="score-slider-val" style="font-size:0.8rem;color:var(--text-secondary)">\${overrideScore ?? liveScore}</span>
        <button onclick="saveScoreOverride('\${jsAttr(c.id)}', document.getElementById('score-slider').value)" style="background:var(--accent);border:none;color:white;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:0.72rem;font-family:inherit">Save</button>
        \${overrideScore ? \`<button onclick="clearScoreOverride('\${jsAttr(c.id)}')" style="background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:4px;padding:2px 8px;cursor:pointer;font-size:0.72rem;font-family:inherit">Clear</button>\` : ''}
      </div>
    </div>
    <div class="detail-body">
      <div>
        <div id="timeline-slot"></div>
        <div class="detail-section">
          <h3>Info</h3>
          <div class="info-grid">
            \${infoHtml || '<div class="info-value empty" style="grid-column:span 2">No info available</div>'}
          </div>
        </div>
        \${apolloHtml}
        <div id="insights-card-slot"></div>
        <div class="detail-section" id="interactions-section">
          <h3>Conversations <span style="color:var(--text-muted);font-weight:400;font-size:0.65rem" id="conv-count">\u2014 loading\u2026</span></h3>
          <div id="interactions-body" style="color:var(--text-muted);font-size:0.82rem">Loading\u2026</div>
        </div>
      </div>
      <div>
        \${renderSharedGroupsCard(c)}
        <div class="detail-section" id="intro-paths-card">
          <h3>Warmest paths to this person <span style="color:var(--text-muted);font-weight:400;font-size:0.65rem" id="intro-paths-status">\u2014 loading\u2026</span></h3>
          <div id="intro-paths-body" style="color:var(--text-muted);font-size:0.82rem">Loading\u2026</div>
        </div>
        <div class="detail-section">
          <h3>Notes <span style="color:var(--text-muted);font-weight:400;font-size:0.65rem">\u2014 use @name to link other contacts</span></h3>
          <textarea class="notes-area" id="notes-area" placeholder="Add notes about this person\u2026 (try @name to link)">\${esc(c.notes || '')}</textarea>
          <div id="notes-preview" style="display:none;font-size:0.85rem;color:var(--text-secondary);padding:8px 10px;background:rgba(99,102,241,0.04);border-radius:6px;margin-top:6px;line-height:1.5"></div>
          <div class="notes-saved" id="notes-saved"></div>
        </div>
        \${renderMentionBacklinks(c.mentionBacklinks || [])}
      </div>
    </div>
  \`;

  // Wire up notes save + mention preview
  let notesTimer = null;
  const notesArea = document.getElementById('notes-area');
  const notesPreview = document.getElementById('notes-preview');
  function renderNotesMentionPreview(text) {
    if (!notesPreview) return;
    // Render mentions inline with simple local resolution against allContacts.
    if (!text || !/@[A-Za-z]/.test(text)) { notesPreview.style.display = 'none'; notesPreview.innerHTML = ''; return; }
    const html = renderMentionsInline(text);
    if (!html.includes('mention-link')) { notesPreview.style.display = 'none'; notesPreview.innerHTML = ''; return; }
    notesPreview.style.display = 'block';
    notesPreview.innerHTML = '<div style="font-size:0.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Preview</div>' + html;
  }
  renderNotesMentionPreview(c.notes || '');
  notesArea.addEventListener('input', e => {
    clearTimeout(notesTimer);
    document.getElementById('notes-saved').textContent = '';
    const val = e.target.value;
    renderNotesMentionPreview(val);
    notesTimer = setTimeout(async () => {
      await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(c.id)}/notes\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: val }),
      });
      const saved = document.getElementById('notes-saved');
      if (saved) { saved.textContent = 'Saved'; setTimeout(() => { if(saved) saved.textContent=''; }, 2000); }
    }, 800);
  });

  // Load interactions and insights async
  loadInteractions(c.id);
  loadInsightsCard(c.id);
  loadTimeline(c.id);
  loadIntroPaths(c.id);
}

function renderSharedGroupsCard(c) {
  const groups = c.sharedGroups || [];
  if (!groups.length) return '';
  const items = groups.slice(0, 8).map(g => {
    const sizeLabel = g.size ? g.size + ' member' + (g.size === 1 ? '' : 's') : '—';
    const adminBadge = g.isSuperAdmin ? ' <span style="color:#fbbf24;font-size:0.65rem">★ creator</span>'
                     : g.isAdmin ? ' <span style="color:#60a5fa;font-size:0.65rem">admin</span>' : '';
    return \`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);font-size:0.82rem">
      <span style="color:var(--text-primary)">\${esc(g.name)}\${adminBadge}</span>
      <span style="color:var(--text-muted);font-size:0.72rem">\${sizeLabel}</span>
    </div>\`;
  }).join('');
  const more = groups.length > 8 ? \`<div style="color:var(--text-muted);font-size:0.72rem;margin-top:6px">+ \${groups.length - 8} more</div>\` : '';
  return \`<div class="detail-section">
    <h3>You're both in <span style="color:var(--text-muted);font-weight:400;font-size:0.65rem">\${groups.length} group\${groups.length===1?'':'s'}</span></h3>
    \${items}\${more}
  </div>\`;
}

async function loadIntroPaths(contactId) {
  const body = document.getElementById('intro-paths-body');
  const status = document.getElementById('intro-paths-status');
  if (!body) return;
  let data;
  try {
    data = await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(contactId)}/intro-paths\`).then(r => r.json());
  } catch (e) {
    body.innerHTML = '<div class="loading">Could not load intro paths</div>';
    if (status) status.textContent = '';
    return;
  }
  if (status) status.textContent = '';
  if (!data || !data.paths || data.paths.length === 0) {
    body.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem">No warm paths found — this contact is only in groups that are too large for reliable intros.</div>';
    return;
  }
  body.innerHTML = data.paths.map((p, i) => {
    const roleStr = [p.intermediaryTitle, p.intermediaryCompany].filter(Boolean).join(' at ');
    const scoreColor = p.intermediaryScore >= 70 ? 'var(--health-strong)' :
                       p.intermediaryScore >= 40 ? 'var(--health-warm)' :
                       p.intermediaryScore >= 20 ? 'var(--health-fading)' : 'var(--health-cold)';
    const groupChips = p.sharedGroupsWithTarget.map(g =>
      \`<span style="display:inline-block;background:var(--surface-alt);padding:2px 6px;border-radius:4px;font-size:0.68rem;margin-right:4px">\${esc(g.name)} · \${g.size}</span>\`
    ).join('');
    return \`<div style="padding:8px 0;\${i===data.paths.length-1?'':'border-bottom:1px solid var(--border)'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
        <button style="background:none;border:none;color:var(--text-primary);font-weight:600;font-size:0.88rem;cursor:pointer;padding:0;text-align:left" onclick="openContact('\${jsAttr(p.intermediaryId)}')">\${esc(p.intermediaryName)}</button>
        <span style="color:\${scoreColor};font-size:0.72rem;font-weight:600">\${p.intermediaryScore}</span>
      </div>
      \${roleStr ? \`<div style="color:var(--text-muted);font-size:0.72rem;margin-bottom:6px">\${esc(roleStr)}</div>\` : ''}
      <div>\${groupChips}</div>
    </div>\`;
  }).join('');
}

async function loadInsightsCard(contactId) {
  const slot = document.getElementById('insights-card-slot');
  if (!slot) return;
  const ins = await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(contactId)}/insights\`).then(r => r.json());
  if (!ins || !ins.analyzedAt) return; // no synthesized insights yet

  const srcColors = { whatsapp:'#34d399', linkedin:'#60a5fa', email:'#facc15', sms:'#c084fc', telegram:'#38bdf8' };

  const sentimentHtml = ins.sentiment
    ? \`<span class="sentiment-pill sentiment-\${ins.sentiment}">\${ins.sentiment}</span>\`
    : '';
  const briefHtml = ins.meetingBrief
    ? \`<div class="insight-brief">\${esc(ins.meetingBrief)}</div>\`
    : '';

  const metaParts = [];
  if (ins.timeKnownDays != null) {
    const yrs = Math.floor(ins.timeKnownDays / 365);
    const mos = Math.floor((ins.timeKnownDays % 365) / 30);
    metaParts.push('Known ' + (yrs > 0 ? yrs + 'yr ' : '') + (mos > 0 ? mos + 'mo' : (yrs === 0 ? ins.timeKnownDays + 'd' : '')));
  }
  if (ins.channelSummary) metaParts.push(ins.channelSummary);
  const metaHtml = metaParts.length
    ? \`<div class="insight-meta"><span>\${metaParts.join('&ensp;·&ensp;')}</span></div>\`
    : '';

  const topicsHtml = ins.topics && ins.topics.length
    ? \`<div class="topic-tags">\${ins.topics.map(t => \`<span class="topic-tag">\${esc(t)}</span>\`).join('')}</div>\`
    : '';
  const loopsHtml = ins.openLoops && ins.openLoops.length
    ? \`<ul class="open-loops">\${ins.openLoops.map(l => \`<li><span class="loop-icon">&#10003;</span>\${esc(l)}</li>\`).join('')}</ul>\`
    : '';

  const timelineHtml = ins.recentMsgs && ins.recentMsgs.length ? \`
    <div class="mini-timeline">
      <div class="mini-timeline-title">Last conversations</div>
      \${ins.recentMsgs.map(m => {
        const color = srcColors[m.source] || '#94a3b8';
        const d = m.timestamp ? new Date(m.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '—';
        return \`<div class="mini-msg">
          <span class="mini-msg-src" style="color:\${color}">\${esc(m.source)}</span>
          <span class="mini-msg-date">\${esc(d)}</span>
          <span class="mini-msg-body">\${esc(m.snippet)}</span>
        </div>\`;
      }).join('')}
    </div>\` : '';

  slot.innerHTML = \`<div class="insights-card">
    <h3>Context Brief</h3>
    \${sentimentHtml}
    \${metaHtml}
    \${briefHtml}
    \${topicsHtml}
    \${loopsHtml}
    \${timelineHtml}
  </div>\`;
}

async function loadTimeline(contactId) {
  const slot = document.getElementById('timeline-slot');
  if (!slot) return;
  let data;
  try {
    data = await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(contactId)}/timeline\`).then(r => r.json());
  } catch(e) { return; }
  if (!data || !data.months) return;

  // Populate hero "known since" label
  if (data.firstInteraction) {
    const knownEl = document.getElementById('hero-known');
    if (knownEl) {
      const d = new Date(data.firstInteraction);
      knownEl.textContent = 'Known since ' + d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    }
  }

  const months = data.months;
  const maxCount = Math.max(...months.map(m => m.count), 1);
  const W = 340, H = 52, barW = Math.floor(W / months.length) - 1;
  const arcLabels = { growing: 'Growing \u2191', stable: 'Stable \u2192', fading: 'Fading \u2193', revived: 'Revived \u2191\u2191' };
  const arcColors  = { growing: 'var(--health-strong)', stable: 'var(--accent)', fading: 'var(--health-fading)', revived: 'var(--health-warm)' };
  const arcClass = data.arc || 'stable';

  const bars = months.map((m, i) => {
    const bh = Math.max(m.count > 0 ? 4 : 1, Math.round((m.count / maxCount) * (H - 6)));
    const x = i * (barW + 1);
    const y = H - bh;
    const opacity = m.count === 0 ? 0.08 : 0.85;
    return \`<rect x="\${x}" y="\${y}" width="\${barW}" height="\${bh}" rx="1" fill="var(--accent)" opacity="\${opacity}"/>\`;
  }).join('');

  slot.innerHTML = \`<div class="rel-timeline">
    <div class="rel-timeline-header">
      <div class="rel-timeline-title">Relationship Timeline</div>
      <span class="rel-arc arc-\${arcClass}" style="color:\${arcColors[arcClass]||'var(--accent)'}">\${arcLabels[arcClass] || arcClass}</span>
    </div>
    <svg width="\${W}" height="\${H}" style="display:block;width:100%;overflow:visible">\${bars}</svg>
    <div class="rel-timeline-meta">
      \${data.totalCount ? \`<span>\${data.totalCount} conversations total</span>\` : ''}
    </div>
  </div>\`;
}

async function loadInteractions(contactId) {
  const interactions = await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(contactId)}/interactions\`).then(r => r.json());
  const el = document.getElementById('interactions-body');
  const countEl = document.getElementById('conv-count');
  if (!el) return;

  if (countEl) countEl.textContent = '\u2014 ' + interactions.length + ' found';

  if (interactions.length === 0) {
    el.innerHTML = '<div style="color:var(--text-muted);font-style:italic;padding:8px 0">No conversations recorded yet.</div>';
    return;
  }

  const SRC_COLORS = { whatsapp:'#34d399', linkedin:'#60a5fa', email:'#facc15', sms:'#c084fc', telegram:'#38bdf8' };
  const SHOW_INIT = 30;
  let shown = SHOW_INIT;

  function renderRows(list) {
    // Group by date
    const groups = {};
    for (const ix of list) {
      const dayKey = ix.timestamp ? new Date(ix.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'Unknown date';
      if (!groups[dayKey]) groups[dayKey] = [];
      groups[dayKey].push(ix);
    }
    return Object.entries(groups).map(([day, items]) => {
      const msgs = items.map(i => {
        const color = SRC_COLORS[i.source] || 'var(--text-muted)';
        const body = (i.body || i.subject || '').slice(0, 140);
        const chat = i.chatName ? esc(i.chatName) : '';
        return \`<div style="display:flex;gap:10px;padding:5px 0;font-size:0.78rem;align-items:flex-start">
          <div style="color:\${color};font-size:0.65rem;font-weight:700;width:44px;flex-shrink:0;padding-top:3px;text-transform:uppercase">\${esc(i.source||'')}</div>
          <div style="flex:1;min-width:0">
            \${chat ? \`<div style="color:var(--text-muted);font-size:0.68rem;margin-bottom:1px">\${chat}</div>\` : ''}
            <div style="color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${esc(body)}</div>
          </div>
        </div>\`;
      }).join('');
      return \`<div style="margin-bottom:12px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;color:var(--text-muted);margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--border)">\${esc(day)}</div>
        \${msgs}
      </div>\`;
    }).join('');
  }

  function render() {
    const slice = interactions.slice(0, shown);
    const html = renderRows(slice);
    const moreCount = interactions.length - shown;
    const moreBtn = moreCount > 0
      ? \`<button onclick="expandConvs()" style="margin-top:4px;background:none;border:1px solid var(--border);border-radius:20px;color:var(--text-muted);font-size:0.75rem;padding:4px 14px;cursor:pointer;font-family:inherit">Show \${Math.min(moreCount, 30)} more</button>\`
      : '';
    el.innerHTML = html + moreBtn;
  }

  window.expandConvs = function() { shown = Math.min(shown + 30, interactions.length); render(); };
  render();
}

// ============================================================
// Reconnect dashboard
// ============================================================
async function loadReconnect() {
  const el = document.getElementById('reconnect-list');
  el.innerHTML = '<div class="loading">Finding relationships to rekindle…</div>';
  const d = await fetch(BASE + '/api/reconnect').then(r => r.json());

  if (d.contacts.length === 0) {
    el.innerHTML = \`<div class="reconnect-empty">
      <div style="font-size:2rem;margin-bottom:12px">Your network is healthy</div>
      <div>No strong relationships going cold right now. Keep it up.</div>
    </div>\`;
    return;
  }

  const sourceColors = { whatsapp:'#34d399', linkedin:'#60a5fa', email:'#facc15', sms:'#c084fc', telegram:'#38bdf8' };
  const sourceLabel = { whatsapp:'WhatsApp', linkedin:'LinkedIn', email:'Email', sms:'SMS', telegram:'Telegram' };

  el.innerHTML = d.contacts.map(c => {
    const role = [c.position, c.company].filter(Boolean).join(' at ');
    const dots = (c.activeChannels || []).map(s =>
      \`<div class="dot dot-\${s}" title="\${s}"></div>\`).join('');
    const lastWhere = c.lastSource ? \`via \${sourceLabel[c.lastSource] || c.lastSource}\` : '';
    const snippet = c.lastSnippet
      ? \`"\${esc(c.lastSnippet)}" \${lastWhere}\`
      : \`No recorded messages \${lastWhere}\`;
    return \`<div class="reconnect-card">
      <div class="reconnect-top">
        <div class="avatar" style="background:\${avatarColor(c.id).bg};color:\${avatarColor(c.id).fg};width:42px;height:42px;font-size:0.9rem">
          \${esc(getInitials(c.name))}
        </div>
        <div class="reconnect-info">
          <div class="reconnect-name" onclick="openContact('\${esc(c.id)}')">\${esc(c.name)}</div>
          \${role ? \`<div class="reconnect-role">\${esc(role)}</div>\` : ''}
        </div>
        <div class="reconnect-age">\${c.daysSinceContact}d ago</div>
      </div>
      <div class="reconnect-snippet">\${snippet}</div>
      <div class="reconnect-bottom">
        <div class="source-dots">\${dots}</div>
        <div class="reconnect-actions">
          <button class="btn-reconnect" onclick="copyName('\${jsAttr(c.name)}')">Copy name</button>
          <button class="btn-reconnect" onclick="openContact('\${esc(c.id)}')">View profile</button>
        </div>
      </div>
    </div>\`;
  }).join('');
}

function copyName(name) {
  navigator.clipboard.writeText(name).catch(() => {});
}

// ============================================================
// Reconnect message composer (TASK-026)
// ============================================================
let _draftContactId = null;
let _draftContactName = '';

async function openDraftPanel(contactId, name) {
  _draftContactId = contactId;
  _draftContactName = name || '';
  let draft = '';
  let isPreGenerated = false;
  try {
    const ins = await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(contactId)}/insights\`).then(r => r.json());
    if (ins && ins.reconnectDraft) { draft = ins.reconnectDraft; isPreGenerated = true; }
  } catch(e) {}
  if (!draft) draft = \`Hey \${name || 'there'}, it's been a while \u2014 I was thinking about you and wanted to reach out. Hope things are going well.\`;

  _renderDraftPanel(draft, isPreGenerated);
}

function _renderDraftPanel(draft, isPreGenerated) {
  document.getElementById('draft-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'draft-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:1000;display:flex;align-items:flex-end;justify-content:center';
  overlay.innerHTML = \`<div style="background:var(--bg-card);border-top:1px solid var(--border);border-radius:16px 16px 0 0;padding:24px;width:100%;max-width:640px;box-shadow:0 -8px 40px rgba(0,0,0,0.5)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <div style="font-size:13px;font-weight:600;color:var(--text-primary)">Draft message</div>
      <button onclick="document.getElementById('draft-overlay').remove()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1.3rem;padding:0;line-height:1">&times;</button>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">\${isPreGenerated ? 'Context-aware draft \u2014 edit before sending' : 'Template draft \u2014 personalise before sending'}</div>
    <textarea id="draft-textarea" style="width:100%;min-height:130px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--text-primary);font-size:0.9rem;line-height:1.65;resize:vertical;font-family:inherit;outline:none;box-sizing:border-box;transition:border-color 180ms ease" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'">\${esc(draft)}</textarea>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
      <button id="draft-regen-btn" onclick="triggerRegenDraft()" style="padding:8px 14px;background:none;border:1px solid var(--accent);border-radius:8px;color:var(--accent);font-size:0.8rem;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:6px;transition:background 180ms ease" onmouseover="this.style.background='rgba(99,102,241,0.1)'" onmouseout="this.style.background='none'">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        Regenerate
      </button>
      <div style="flex:1"></div>
      <button onclick="copyDraft('WhatsApp')" id="copy-wa" style="padding:8px 12px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:0.8rem;cursor:pointer;font-family:inherit;transition:border-color 180ms,color 180ms">Copy for WhatsApp</button>
      <button onclick="copyDraft('Email')" id="copy-em" style="padding:8px 12px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:0.8rem;cursor:pointer;font-family:inherit;transition:border-color 180ms,color 180ms">Copy for Email</button>
      <button onclick="copyDraft('LinkedIn')" id="copy-li" style="padding:8px 12px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:0.8rem;cursor:pointer;font-family:inherit;transition:border-color 180ms,color 180ms">Copy for LinkedIn</button>
    </div>
  </div>\`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function triggerRegenDraft() {
  if (!_draftContactId) return;
  const btn = document.getElementById('draft-regen-btn');
  if (btn) { btn.textContent = 'Regenerating\u2026'; btn.disabled = true; }
  try {
    const res = await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(_draftContactId)}/regenerate-draft\`, { method: 'POST' });
    const { draft } = await res.json();
    if (draft) {
      const ta = document.getElementById('draft-textarea');
      if (ta) {
        ta.style.opacity = '0';
        setTimeout(() => { ta.value = draft; ta.style.opacity = '1'; ta.style.transition = 'opacity 180ms ease'; }, 150);
      }
    }
  } catch(e) {}
  if (btn) {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Regenerate';
    btn.disabled = false;
  }
}

function copyDraft(channel) {
  const ta = document.getElementById('draft-textarea');
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).catch(() => {});
  // Visual feedback: show "Copied!" briefly then close
  const btnMap = { WhatsApp: 'copy-wa', Email: 'copy-em', LinkedIn: 'copy-li' };
  const btnEl = document.getElementById(btnMap[channel]);
  if (btnEl) {
    const original = btnEl.textContent;
    btnEl.textContent = 'Copied!';
    btnEl.style.borderColor = 'var(--health-strong)';
    btnEl.style.color = 'var(--health-strong)';
    setTimeout(() => {
      btnEl.textContent = original;
      btnEl.style.borderColor = '';
      btnEl.style.color = '';
      document.getElementById('draft-overlay')?.remove();
    }, 1200);
  } else {
    document.getElementById('draft-overlay')?.remove();
  }
}

// ============================================================
// Communities (group chats)
// ============================================================
let groupsData = null;

async function loadGroups() {
  const el = document.getElementById('groups-list');
  el.innerHTML = '<div class="loading">Loading communities…</div>';
  const d = await fetch(BASE + '/api/groups').then(r => r.json());
  groupsData = d.groups;
  renderGroupsList(d.groups);
}

function renderGroupsList(groups) {
  const el = document.getElementById('groups-list');
  const catColors = { professional:'cat-professional', university:'cat-university',
                      social:'cat-social', personal:'cat-personal', other:'cat-other' };
  el.innerHTML = groups.map(g => {
    const lastAt = g.lastMessageAt ? new Date(g.lastMessageAt).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '—';
    const catCls = catColors[g.category] || 'cat-other';
    return \`<div class="group-item" id="gi-\${esc(g.chatId)}" onclick="loadGroupDetail('\${esc(g.chatId)}')">
      <div class="group-item-top">
        <span class="group-name">\${esc(g.name)}</span>
        <span class="group-cat \${catCls}">\${esc(g.category)}</span>
      </div>
      <div class="group-meta">
        <span>\${g.messageCount} msgs</span>
        <span>Active \${lastAt}</span>
      </div>
      <div class="group-snippet">\${esc(g.lastSnippet)}</div>
    </div>\`;
  }).join('');
}

async function saveLidLabels(chatId) {
  const mapping = {};
  document.querySelectorAll('.lid-label-select').forEach(sel => {
    const lid = sel.dataset.lid;
    const target = sel.value;
    if (lid && target) mapping[lid] = target;
  });
  if (Object.keys(mapping).length === 0) return;
  const btn = document.querySelector('.lid-label-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const r = await fetch(BASE + '/api/whatsapp/lid-map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping }),
    }).then(r => r.json());
    if (btn) btn.textContent = 'Saved · ' + r.added + ' label' + (r.added === 1 ? '' : 's');
    // Reload group detail so messages re-render with the new names
    setTimeout(() => loadGroupDetail(chatId), 400);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save labels'; }
    console.error('lid-map save failed', e);
  }
}

async function loadGroupDetail(chatId) {
  // Highlight selected
  document.querySelectorAll('.group-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById('gi-' + chatId);
  if (item) item.classList.add('active');

  const detail = document.getElementById('groups-detail');
  detail.innerHTML = '<div class="groups-detail-empty loading">Loading…</div>';

  const encodedId = encodeURIComponent(chatId);
  const g = await fetch(\`\${BASE}/api/groups/\${encodedId}\`).then(r => r.json());

  const catColors = { professional:'cat-professional', university:'cat-university',
                      social:'cat-social', personal:'cat-personal', other:'cat-other' };
  const catCls = catColors[g.category] || 'cat-other';
  const lastAt = g.lastMessageAt ? new Date(g.lastMessageAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '—';

  const feedHtml = g.messages.map(m => {
    const d = m.timestamp ? new Date(m.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '';
    const t = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) : '';
    // Server-resolved fromName (handles @c.us → contact name, @lid → 'Group member',
    // raw phone → +XX formatted) — never show the raw id.
    const display = m.fromName || (m.from === 'me' ? 'You' : 'Group member');
    const clickable = m.fromContactId
      ? \`<span class="group-msg-from group-msg-from-link" onclick="event.stopPropagation();openContact('\${jsAttr(m.fromContactId)}')">\${esc(display)}</span>\`
      : \`<span class="group-msg-from">\${esc(display)}</span>\`;
    return \`<div class="group-msg">
      <div class="group-msg-meta">
        \${clickable}
        <span>\${d} \${t}</span>
      </div>
      <div class="group-msg-body">\${esc(m.body)}</div>
    </div>\`;
  }).join('');

  const sig = g.signals;
  const sigSection = (title, icon, items, renderFn) => {
    if (!items.length) return '';
    return \`<div class="signal-section">
      <div class="signal-title">\${icon} \${title} <span style="color:#374151">\${items.length}</span></div>
      \${items.map(renderFn).join('')}
    </div>\`;
  };
  const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '';

  const urlSection = sig.urls.length ? \`<div class="signal-section">
    <div class="signal-title">🔗 Links <span style="color:#374151">\${sig.urls.length}</span></div>
    \${sig.urls.map(u => \`<div class="signal-item">
      <a href="\${esc(u.url)}" target="_blank">\${esc(u.url.replace(/^https?:\\/\\//, '').slice(0, 50))}</a>
      <span class="signal-date">\${fmtDate(u.timestamp)}</span>
    </div>\`).join('')}
  </div>\` : '';

  const hiringSection = sigSection('Hiring signals', '💼', sig.hiring, h =>
    \`<div class="signal-item">\${esc(h.snippet)}<span class="signal-date">\${fmtDate(h.timestamp)}</span></div>\`);
  const eventSection = sigSection('Events', '📅', sig.events, e =>
    \`<div class="signal-item">\${esc(e.snippet)}<span class="signal-date">\${fmtDate(e.timestamp)}</span></div>\`);
  const introSection = sigSection('Intros', '🤝', sig.intros, i =>
    \`<div class="signal-item">\${esc(i.snippet)}<span class="signal-date">\${fmtDate(i.timestamp)}</span></div>\`);

  const noSignals = !sig.urls.length && !sig.hiring.length && !sig.events.length && !sig.intros.length;

  // Pinned messages — user-curated "important" content. Surface at the top of the feed.
  const pinned = g.pinnedMessages || [];
  const pinnedHtml = pinned.length ? \`<div class="signal-section" style="background:var(--surface-alt,#1a1f2b);padding:12px;border-radius:6px;margin-bottom:12px">
    <div class="signal-title">📌 Pinned <span style="color:#374151">\${pinned.length}</span></div>
    \${pinned.map(m => {
      const who = m.fromName || (m.from === 'me' ? 'You' : 'Group member');
      return \`<div class="signal-item" style="margin-bottom:8px">
        <div style="font-weight:600;font-size:0.72rem;color:var(--text-muted)">\${esc(who)} · \${fmtDate(m.timestamp)}</div>
        <div style="color:var(--text-primary);font-size:0.82rem;margin-top:2px">\${esc((m.body || '').slice(0, 280))}</div>
      </div>\`;
    }).join('')}
  </div>\` : '';

  // Group metadata header: creator, age, description
  const metaHeaderParts = [];
  if (g.rosterCount) metaHeaderParts.push(\`\${g.rosterCount} members\`);
  if (g.messageCount) metaHeaderParts.push(\`\${g.messageCount} messages\`);
  if (lastAt !== '—') metaHeaderParts.push(\`Last active \${lastAt}\`);
  const metaHeader = metaHeaderParts.join(' · ');
  const descHtml = g.description
    ? \`<p style="color:var(--text-muted);font-size:0.82rem;margin-top:4px;font-style:italic">"\${esc(g.description.slice(0, 200))}"</p>\`
    : '';
  const createdStr = g.createdAt
    ? \` · Created \${new Date(g.createdAt).toLocaleDateString('en-GB', { month:'short', year:'numeric' })}\`
    : '';

  // Anonymous-sender labelling — give the user a way to assign each unique
  // @lid sender to a roster member, persisted to data/whatsapp/lid-map.json.
  const unresolved = g.unresolvedSenders || [];
  const candidates = g.suggestedContacts || [];
  const labelHtml = unresolved.length ? \`<div class="lid-label-panel">
    <div class="lid-label-title">
      \${unresolved.length} anonymous sender\${unresolved.length === 1 ? '' : 's'} in this group
      <span class="lid-label-help">— WhatsApp redacts unsaved members. Match them to roster contacts and the names will stick across all groups.</span>
    </div>
    \${unresolved.slice(0, 12).map((s, i) => \`<div class="lid-label-row">
      <div class="lid-label-info">
        <span class="lid-label-count">\${s.count}</span>
        <span class="lid-label-sample">"\${esc((s.sample || '(no text)').slice(0, 70))}"</span>
      </div>
      <select class="lid-label-select" data-lid="\${jsAttr(s.id)}" id="lid-sel-\${i}">
        <option value="">— assign to —</option>
        \${candidates.map(c => \`<option value="\${esc(c.id)}">\${esc(c.name)}\${c.company ? ' · ' + esc(c.company) : ''}</option>\`).join('')}
      </select>
    </div>\`).join('')}
    \${unresolved.length > 12 ? '<div class="lid-label-more">+ ' + (unresolved.length - 12) + ' more — top 12 shown.</div>' : ''}
    <button class="lid-label-save" onclick="saveLidLabels('\${jsAttr(g.chatId)}')">Save labels</button>
  </div>\` : '';

  // Roster — show known members as clickable chips, anonymous LIDs as a count
  const roster = g.roster || [];
  const namedMembers = roster.filter(r => r.name && !/^\\+/.test(r.name) && r.name !== '(unknown)');
  const phoneOnly = roster.filter(r => r.name && /^\\+/.test(r.name));
  const anonCount = (g.rosterCount || roster.length) - namedMembers.length - phoneOnly.length;
  const rosterHtml = roster.length ? \`<div class="group-roster">
    <div class="group-roster-title">Roster — \${g.rosterCount || roster.length} member\${(g.rosterCount || roster.length) === 1 ? '' : 's'}</div>
    \${namedMembers.slice(0, 60).map(r => \`<span class="group-roster-chip" onclick="openContact('\${jsAttr(r.id)}')">\${esc(r.name)}\${r.company ? ' · ' + esc(r.company) : ''}</span>\`).join('')}
    \${phoneOnly.slice(0, 20).map(r => \`<span class="group-roster-chip" onclick="openContact('\${jsAttr(r.id)}')">\${esc(r.name)}</span>\`).join('')}
    \${anonCount > 0 ? \`<span class="group-roster-chip group-roster-chip-anon">+\${anonCount} anonymous</span>\` : ''}
  </div>\` : '';

  detail.innerHTML = \`
    <div class="group-detail-header">
      <h3>\${esc(g.name)} <span class="group-cat \${catCls}" style="vertical-align:middle">\${esc(g.category)}</span></h3>
      <p>\${metaHeader}\${createdStr}</p>
      \${descHtml}
    </div>
    \${rosterHtml}
    <div class="group-detail-body">
      <div class="group-feed">\${labelHtml}\${pinnedHtml}\${feedHtml || (pinned.length ? '' : '<div class="loading">No messages found</div>')}</div>
      <div class="group-signals">
        <div class="signal-title" style="margin-bottom:12px">Signals</div>
        \${urlSection}\${hiringSection}\${eventSection}\${introSection}
        \${noSignals ? '<div class="signals-empty">No signals detected in this group yet.</div>' : ''}
      </div>
    </div>\`;
}

// ============================================================
// This Week (digest)
// ============================================================
async function loadDigest() {
  const el = document.getElementById('digest-body');
  el.innerHTML = '<div class="loading">Loading digest…</div>';
  const d = await fetch(BASE + '/api/digest').then(r => r.json());

  if (!d) {
    el.innerHTML = \`<div class="empty-state">No digest yet. Run <code>npm run digest</code> then ask Claude Code to fill in the summary.</div>\`;
    return;
  }

  const s = d.networkStats || {};
  const stats = \`<div class="digest-stats">
    <div class="digest-stat"><div class="digest-stat-num">\${s.total||0}</div><div class="digest-stat-label">People</div></div>
    <div class="digest-stat"><div class="digest-stat-num" style="color:#34d399">\${s.activeThisWeek||0}</div><div class="digest-stat-label">Active this week</div></div>
    <div class="digest-stat"><div class="digest-stat-num" style="color:#34d399">\${s.strong||0}</div><div class="digest-stat-label">Strong</div></div>
    <div class="digest-stat"><div class="digest-stat-num" style="color:#f97316">\${s.atRisk||0}</div><div class="digest-stat-label">At risk</div></div>
    <div class="digest-stat"><div class="digest-stat-num" style="color:#64748b">\${s.dormant||0}</div><div class="digest-stat-label">Dormant</div></div>
  </div>\`;

  const summaryHtml = d.weekSummary
    ? \`<div class="digest-summary"><h3>Week Summary</h3><p>\${esc(d.weekSummary)}</p></div>\`
    : '<div class="digest-summary"><h3>Week Summary</h3><p style="color:#374151;font-style:italic">No summary yet — ask Claude Code to read digest.json and fill in weekSummary.</p></div>';

  const contactRow = (c) => {
    const meta = [c.position, c.company].filter(Boolean).join(' · ');
    const days = c.daysSinceContact != null ? \`\${c.daysSinceContact}d ago\` : '';
    return \`<div class="digest-contact-row" onclick="openContact('\${esc(c.id)}')">
      <div class="digest-contact-name">\${esc(c.name)}</div>
      \${meta ? \`<div class="digest-contact-meta">\${esc(meta)}</div>\` : ''}
      \${days ? \`<div class="digest-contact-meta">\${days}</div>\` : ''}
    </div>\`;
  };

  const activeHtml = d.activeThisWeek?.length
    ? \`<div class="digest-section"><h3>Active this week</h3>\${d.activeThisWeek.map(contactRow).join('')}</div>\` : '';

  const reconnectHtml = d.topReconnects?.length
    ? \`<div class="digest-section"><h3>Reconnect this week</h3>\${d.topReconnects.map(contactRow).join('')}</div>\` : '';

  const loopsHtml = d.openLoops?.length
    ? \`<div class="digest-section"><h3>Open loops to close</h3>
      \${d.openLoops.map(l => \`<div class="digest-loop-item">
        <div class="digest-loop-contact" onclick="openContact('\${esc(l.contactId)}')" style="cursor:pointer">\${esc(l.contactName)}</div>
        <div class="digest-loop-text">\${esc(l.loop)}</div>
      </div>\`).join('')}
    </div>\` : '';

  const warmIntroHtml = d.warmIntroBriefs?.length
    ? \`<div class="digest-section"><h3>Warm paths you didn't know you had</h3>
      \${d.warmIntroBriefs.map(b => {
        const roleStr = [b.intermediary.title, b.intermediary.company].filter(Boolean).join(' at ');
        const via = b.sharedGroup ? \`via \${esc(b.sharedGroup.name)} (\${b.sharedGroup.size})\` : '';
        return \`<div class="digest-loop-item">
          <div>
            <span class="digest-loop-contact" onclick="openContact('\${esc(b.target.id)}')" style="cursor:pointer">\${esc(b.target.name)}</span>
            <span style="color:var(--text-muted);font-size:0.72rem"> ← intro via </span>
            <span class="digest-loop-contact" onclick="openContact('\${esc(b.intermediary.id)}')" style="cursor:pointer">\${esc(b.intermediary.name)}</span>
          </div>
          <div class="digest-loop-text" style="font-size:0.72rem">\${esc(roleStr)}\${roleStr && via ? ' · ' : ''}\${via}</div>
        </div>\`;
      }).join('')}
    </div>\` : '';

  const generatedAt = new Date(d.generatedAt).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });
  el.innerHTML = [
    stats,
    summaryHtml,
    warmIntroHtml,
    activeHtml,
    reconnectHtml,
    loopsHtml,
    \`<div class="digest-generated">Generated \${generatedAt} · run <code>npm run digest</code> to refresh</div>\`,
  ].filter(Boolean).join('');
}

// ============================================================
// Intros
// ============================================================
let introFindDebounce = null;
function wireIntroFinder() {
  const input = document.getElementById('intro-find-input');
  if (!input || input.dataset.wired) return;
  input.dataset.wired = '1';
  input.addEventListener('input', () => {
    clearTimeout(introFindDebounce);
    const q = input.value.trim();
    introFindDebounce = setTimeout(() => runIntroFind(q), 150);
  });
}

async function runIntroFind(q) {
  const el = document.getElementById('intro-find-results');
  if (!el) return;
  if (q.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="loading" style="padding:10px 0;font-size:12px">Finding paths…</div>';
  try {
    const r = await fetch(BASE + '/api/intros/find?q=' + encodeURIComponent(q) + '&limit=3').then(r => r.json());
    renderIntroFindResults(el, r);
  } catch (e) {
    el.innerHTML = '<div class="loading" style="color:#ef4444">Error: ' + esc(e.message) + '</div>';
  }
}

function renderIntroFindResults(el, data) {
  if (!data.targets || data.targets.length === 0) {
    el.innerHTML = '<div class="intro-no-paths">No contacts match that query.</div>';
    return;
  }
  el.innerHTML = data.targets.map(t => {
    const role = [t.target.position, t.target.company].filter(Boolean).join(' · ');
    const initials = esc(getInitials(t.target.name || '?'));
    const col = avatarColor(t.target.id);
    const warmth = t.target.relationshipScore;
    const warmBadge = warmth >= 50
      ? '<span class="intro-path-score" style="background:rgba(34,197,94,0.15);color:#86efac">You already know — score ' + warmth + '</span>'
      : warmth > 0
      ? '<span class="intro-path-score">Known, score ' + warmth + '</span>'
      : '<span class="intro-path-score">Cold</span>';
    const pathsHtml = t.paths.length === 0
      ? '<div class="intro-no-paths">No warm paths via shared groups. Try reaching out directly if they\\'re in your contacts, or import more sources to uncover more paths.</div>'
      : t.paths.map(p => {
          const tier = p.intermediaryScore >= 70 ? 'strong' : p.intermediaryScore >= 40 ? 'good' : p.intermediaryScore >= 20 ? 'warm' : 'fading';
          const iInitials = esc(getInitials(p.intermediaryName || '?'));
          const groups = p.sharedGroupsWithTarget.map(g => '#' + esc(g.name) + ' (' + g.size + ')').join(' · ');
          const roleText = [p.intermediaryTitle, p.intermediaryCompany].filter(Boolean).join(' · ');
          return '<div class="intro-path-row" onclick="openContact(\\'' + esc(p.intermediaryId) + '\\')">'
            + '<div class="intro-path-avatar">' + iInitials + '</div>'
            + '<div class="intro-path-body">'
              + '<div class="intro-target-name">' + esc(p.intermediaryName) + '</div>'
              + '<div class="intro-target-role">' + esc(roleText || '—') + '</div>'
              + '<div class="intro-path-groups">via ' + groups + '</div>'
            + '</div>'
            + '<span class="palette-score-ring ' + tier + '"></span>'
            + '<span class="intro-path-score">score ' + p.intermediaryScore + '</span>'
          + '</div>';
        }).join('');
    return '<div class="intro-target-card">'
      + '<div class="intro-target-head" onclick="openContact(\\'' + esc(t.target.id) + '\\')">'
        + '<div class="intro-path-avatar" style="width:36px;height:36px;background:' + col.bg + '">' + initials + '</div>'
        + '<div style="flex:1">'
          + '<div class="intro-target-name">' + esc(t.target.name || 'Unnamed') + '</div>'
          + '<div class="intro-target-role">' + esc(role || '—') + '</div>'
        + '</div>'
        + warmBadge
      + '</div>'
      + '<div class="intro-paths-head">Warm paths (' + t.paths.length + ')</div>'
      + pathsHtml
    + '</div>';
  }).join('');
}

async function loadIntros() {
  wireIntroFinder();
  const el = document.getElementById('intros-list');
  el.innerHTML = '<div class="loading">Detecting introduction opportunities…</div>';
  const d = await fetch(BASE + '/api/intros').then(r => r.json());

  if (!d.suggestions.length) {
    el.innerHTML = '<div class="empty-state">No clear intro opportunities detected yet.</div>';
    return;
  }

  el.innerHTML = \`<div style="padding:8px 20px;font-size:0.72rem;color:#4a5568;border-bottom:1px solid #0f1117">
    \${d.count} intro opportunities — click "Copy intro" to draft a message
  </div>\` + d.suggestions.map((s, idx) => {
    const aRole = [s.contactA.position, s.contactA.company].filter(Boolean).join(' · ');
    const bRole = [s.contactB.position, s.contactB.company].filter(Boolean).join(' · ');
    return \`<div class="intro-card">
      <div>
        <span class="intro-reason">\${esc(s.reason)}</span>
        <span class="intro-value">intro value \${s.introValue}</span>
      </div>
      <div class="intro-pair">
        <div class="intro-person">
          <div class="intro-name" onclick="openContact('\${esc(s.contactA.id)}')">\${esc(s.contactA.name)}</div>
          <div class="intro-role">\${esc(aRole)}</div>
        </div>
        <div class="intro-connector">→</div>
        <div class="intro-person">
          <div class="intro-name" onclick="openContact('\${esc(s.contactB.id)}')">\${esc(s.contactB.name)}</div>
          <div class="intro-role">\${esc(bRole)}</div>
        </div>
      </div>
      <button class="btn-copy-intro" id="intro-btn-\${idx}" onclick="copyIntro(\${idx}, '\${jsAttr(s.template)}')">
        Copy intro message
      </button>
    </div>\`;
  }).join('');
}

function copyIntro(idx, template) {
  navigator.clipboard.writeText(template).then(() => {
    const btn = document.getElementById('intro-btn-' + idx);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy intro message'; btn.classList.remove('copied'); }, 2000);
  }).catch(() => {});
}

// ============================================================
// Network Map — D3 force-directed bubble graph
// ============================================================
let networkTimer = null;
let networkData = [];
let networkSim = null;

const netColor = d3 ? d3.scaleLinear()
  .domain([0, 20, 50, 70, 100])
  .range(['#374151', '#ef4444', '#f97316', '#fbbf24', '#34d399']) : null;

let networkEdges = [];

async function loadNetwork() {
  const svg = document.getElementById('network-svg');
  if (svg) svg.innerHTML = '<text x="50%" y="50%" fill="#4a5568" text-anchor="middle" dominant-baseline="middle" font-size="14">Loading network…</text>';
  const [compData, edgeData] = await Promise.all([
    fetch(BASE + '/api/network/companies').then(r => r.json()),
    fetch(BASE + '/api/network/edges').then(r => r.json()),
  ]);
  networkData = compData.companies;
  networkEdges = edgeData.edges || [];
  renderNetworkGraph(networkData);
}

function renderNetworkGraph(companies) {
  if (!window.d3) {
    // D3 not loaded (offline) — fall back to list
    renderNetworkList(companies);
    return;
  }
  const container = document.getElementById('network-graph');
  const svg = d3.select('#network-svg');
  const W = container.clientWidth || 700;
  const H = container.clientHeight || 500;
  svg.attr('viewBox', \`0 0 \${W} \${H}\`);
  svg.selectAll('*').remove();

  const maxCount = d3.max(companies, d => d.count) || 1;
  const radius = d => 10 + Math.sqrt(d.count / maxCount) * 50;

  // Industry cluster centers (arranged in a circle)
  const industries = [...new Set(companies.map(d => d.industry))];
  const clusterCenters = {};
  industries.forEach((ind, i) => {
    const angle = (i / industries.length) * 2 * Math.PI - Math.PI / 2;
    clusterCenters[ind] = {
      x: W / 2 + (W * 0.28) * Math.cos(angle),
      y: H / 2 + (H * 0.28) * Math.sin(angle),
    };
  });

  // Pan + zoom
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.3, 4]).on('zoom', e => g.attr('transform', e.transform)));

  // Build company name -> node index map for edges
  const nameMap = {};
  companies.forEach((c, i) => { nameMap[c.name.toLowerCase()] = i; });

  // Filter edges to only those where both ends exist in current companies
  const validEdges = networkEdges.filter(e => {
    return nameMap[e.source.toLowerCase()] !== undefined &&
           nameMap[e.target.toLowerCase()] !== undefined;
  }).map(e => ({
    source: nameMap[e.source.toLowerCase()],
    target: nameMap[e.target.toLowerCase()],
    shared: e.shared || 0,
    strength: e.strength || 0,
  }));

  if (networkSim) networkSim.stop();
  networkSim = d3.forceSimulation(companies)
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('charge', d3.forceManyBody().strength(d => -radius(d) * 4))
    .force('collide', d3.forceCollide().radius(d => radius(d) + 6).strength(0.8))
    .force('link', validEdges.length ? d3.forceLink(validEdges).strength(e => e.strength * 0.3).distance(e => 80 + (1 - e.strength) * 120) : null)
    .force('cluster', alpha => {
      // Gentle pull toward industry cluster center
      for (const d of companies) {
        const center = clusterCenters[d.industry];
        if (!center) continue;
        d.vx += (center.x - d.x) * alpha * 0.03;
        d.vy += (center.y - d.y) * alpha * 0.03;
      }
    })
    .alphaDecay(0.02);

  // Draw edges (links) first (beneath nodes)
  const link = g.selectAll('.bubble-link')
    .data(validEdges)
    .enter().append('line')
      .attr('class', 'bubble-link')
      .attr('stroke', '#818cf8')
      .attr('stroke-opacity', d => 0.2 + d.strength * 0.55)
      .attr('stroke-width', d => 1 + d.strength * 3)
      .style('pointer-events', 'visibleStroke')
      .on('mouseover', (e, d) => {
        const tip = document.getElementById('network-tooltip');
        tip.style.display = 'block';
        const pct = Math.round(d.strength * 100);
        tip.innerHTML = \`<div style="font-weight:600;color:#a78bfa;margin-bottom:3px">Connection strength: \${pct}%</div><div style="font-size:0.72rem;color:#94a3b8">\${d.shared} overlapping quarters</div>\`;
        const box = document.getElementById('network-graph').getBoundingClientRect();
        tip.style.left = (e.clientX - box.left + 14) + 'px';
        tip.style.top = (e.clientY - box.top - 10) + 'px';
      })
      .on('mouseout', hideNetworkTooltip);

  const node = g.selectAll('.bubble-node')
    .data(companies, d => d.name)
    .enter().append('g')
      .attr('class', 'bubble-node')
      .attr('data-company', d => d.name)
      .call(d3.drag()
        .on('start', (e, d) => { if (!e.active) networkSim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on('end',   (e, d) => { if (!e.active) networkSim.alphaTarget(0); d.fx = null; d.fy = null; }))
      .on('click', (e, d) => { e.stopPropagation(); showNetworkDetail(d); })
      .on('mouseover', (e, d) => showNetworkTooltip(e, d))
      .on('mousemove', (e) => moveNetworkTooltip(e))
      .on('mouseout', hideNetworkTooltip);

  node.append('circle')
    .attr('r', radius)
    .attr('fill', d => d.industryColor || netColor(d.avgScore))
    .attr('fill-opacity', 0.5)
    .attr('stroke', d => d.industryColor || netColor(d.avgScore))
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.8);

  node.append('text')
    .text(d => {
      const r = radius(d);
      const maxChars = Math.floor(r / 4.5);
      return r > 18 ? d.name.slice(0, maxChars) : '';
    })
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('fill', '#e2e8f0')
    .attr('font-size', d => Math.max(9, Math.min(13, radius(d) / 3.5)))
    .attr('font-family', 'system-ui, sans-serif')
    .attr('pointer-events', 'none');

  networkSim.on('tick', () => {
    node.attr('transform', d => \`translate(\${Math.max(radius(d), Math.min(W - radius(d), d.x))},\${Math.max(radius(d), Math.min(H - radius(d), d.y))})\`);
    if (link) link
      .attr('x1', d => d.source.x ?? 0)
      .attr('y1', d => d.source.y ?? 0)
      .attr('x2', d => d.target.x ?? 0)
      .attr('y2', d => d.target.y ?? 0);
  });

  // Click on blank area deselects
  svg.on('click', () => {
    svg.selectAll('.bubble-node').classed('selected', false).classed('dimmed', false);
    document.getElementById('network-detail').innerHTML = '<div style="color:#4a5568;font-size:0.8rem;text-align:center;margin-top:40px">Click a company bubble<br>to see your contacts there</div>';
  });

  // Render industry legend
  const legendEl = document.getElementById('network-legend');
  if (legendEl) {
    const seen = new Set();
    const legendItems = companies
      .filter(d => { const k = d.industry; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.industry.localeCompare(b.industry));
    legendEl.innerHTML = legendItems.map(d =>
      \`<span style="display:flex;align-items:center;gap:3px;cursor:pointer" onclick="onNetworkSearch('\${d.industry}')">
        <span style="width:8px;height:8px;border-radius:50%;background:\${d.industryColor};display:inline-block"></span>
        \${esc(d.industry)}
      </span>\`
    ).join('');
  }
}

function showNetworkTooltip(e, d) {
  const tip = document.getElementById('network-tooltip');
  tip.style.display = 'block';
  tip.innerHTML = \`<div style="font-weight:700;color:#f1f5f9;margin-bottom:4px">\${esc(d.name)}</div>
    <div style="font-size:0.72rem;color:\${d.industryColor || '#64748b'};margin-bottom:3px">\${esc(d.industry || '')}</div>
    <div style="font-size:0.75rem;color:#64748b">\${d.count} contact\${d.count===1?'':'s'} · avg score \${d.avgScore}</div>
    \${d.strongest ? \`<div style="font-size:0.72rem;color:#94a3b8;margin-top:4px">\${esc(d.strongest.name)}</div>\` : ''}\`;
  moveNetworkTooltip(e);
}
function moveNetworkTooltip(e) {
  const tip = document.getElementById('network-tooltip');
  const box = document.getElementById('network-graph').getBoundingClientRect();
  let x = e.clientX - box.left + 14, y = e.clientY - box.top - 10;
  if (x + 230 > box.width) x = e.clientX - box.left - 234;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideNetworkTooltip() {
  document.getElementById('network-tooltip').style.display = 'none';
}

function showNetworkDetail(d) {
  // Highlight selected node, dim others
  d3.selectAll('.bubble-node')
    .classed('selected', n => n.name === d.name)
    .classed('dimmed', n => n.name !== d.name);

  const detail = document.getElementById('network-detail');
  const scoreColor = s => s >= 70 ? '#34d399' : s >= 40 ? '#fbbf24' : s >= 20 ? '#f97316' : '#374151';
  const contactRows = d.contacts.map(c => {
    const role = [c.position, c.company].filter(Boolean).join(' · ');
    const sc = scoreColor(c.score);
    return \`<div class="net-detail-contact" onclick="openContact('\${esc(c.id)}')">
      <div class="net-score-dot" style="background:\${sc}"></div>
      <div style="flex:1;min-width:0">
        <div class="net-detail-name">\${esc(c.name)}</div>
        \${c.position ? \`<div class="net-detail-role">\${esc(c.position)}</div>\` : ''}
      </div>
    </div>\`;
  }).join('');

  detail.innerHTML = \`
    <div class="net-detail-company">\${esc(d.name)}</div>
    <div class="net-detail-meta">\${d.count} contact\${d.count===1?'':'s'} · avg score \${d.avgScore}
      <span style="cursor:pointer;color:#60a5fa;margin-left:8px" onclick="filterByCompany('\${jsAttr(d.name)}')" title="Show in Contacts">↗ contacts</span>
    </div>
    \${contactRows}
  \`;
}

function onNetworkSearch(val) {
  clearTimeout(networkTimer);
  networkTimer = setTimeout(() => {
    const q = val.trim().toLowerCase();
    if (!q) {
      d3.selectAll('.bubble-node').classed('dimmed', false).classed('selected', false);
      return;
    }
    d3.selectAll('.bubble-node')
      .classed('dimmed', function(d) {
        return !d.name.toLowerCase().includes(q) && !(d.industry || '').toLowerCase().includes(q);
      })
      .classed('selected', false);
    // Show matching companies in detail panel
    const matches = networkData.filter(co => co.name.toLowerCase().includes(q));
    if (matches.length === 1) showNetworkDetail(matches[0]);
  }, 200);
}

function filterByCompany(company) {
  showView('contacts');
  const input = document.getElementById('search-input');
  input.value = company;
  searchQuery = company.toLowerCase();
  applyFilter();
}

function renderNetworkList(companies) {
  // Fallback list (no D3)
  const detail = document.getElementById('network-detail');
  const svgEl = document.getElementById('network-graph');
  svgEl.innerHTML = '';
  detail.innerHTML = companies.slice(0,20).map(co =>
    \`<div class="net-detail-contact" onclick="filterByCompany('\${jsAttr(co.name)}')">
      <div class="net-score-dot" style="background:\${co.avgScore>=70?'#34d399':co.avgScore>=40?'#fbbf24':'#374151'}"></div>
      <div><div class="net-detail-name">\${esc(co.name)}</div><div class="net-detail-role">\${co.count} contacts</div></div>
    </div>\`).join('');
}

// ============================================================
// Review queue
// ============================================================
async function loadReview() {
  const d = await fetch(BASE + '/api/pending').then(r => r.json());
  reviewItems = d.items;
  renderReview();
}

async function loadReviewCount() {
  const d = await fetch(BASE + '/api/pending').then(r => r.json());
  const badge = document.getElementById('review-badge');
  if (d.total > 0) { badge.textContent = d.total; badge.style.display = ''; }
  else badge.style.display = 'none';
}

function renderReview() {
  const done = Object.keys(reviewDecisions).length;
  const total = reviewItems.length;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  document.getElementById('r-progress-fill').style.width = pct + '%';
  document.getElementById('r-progress-text').textContent = total === 0 ? 'All reviewed' : \`\${done} / \${total}\`;

  const body = document.getElementById('review-body');

  if (reviewCurrent >= reviewItems.length) {
    body.innerHTML = \`<div class="review-empty"><h2>All done!</h2><p>Click Run merge.js to apply decisions.</p></div>
      <div class="merge-output" id="merge-output"></div>\`;
    return;
  }

  const item = reviewItems[reviewCurrent];
  const srcA = item.sourceA || 'whatsapp';
  const srcB = item.sourceB || 'linkedin';
  const cA = item.contactA, cB = item.contactB;
  const prev = reviewDecisions[item._idx];
  const sel = d => prev === d ? 'btn-selected' : '';
  const tagClass = prev ? \`tag-\${prev}\` : '';

  function sourceLabel(src) {
    return { whatsapp: 'WhatsApp', linkedin: 'LinkedIn', googleContacts: 'Google Contacts', sms: 'SMS', email: 'Email' }[src] || src;
  }

  function contactFields(c, src) {
    if (!c) return [['ID', '(not found)']];
    const s = c.sources?.[src];
    const rows = [['Name', c.name || '—']];
    if (src === 'whatsapp') {
      rows.push(['Phone', (c.phones||[]).join(', ') || '—']);
      if (s?.about) rows.push(['About', s.about]);
    } else if (src === 'linkedin') {
      rows.push(['Email', c.emails?.[0] || s?.email || '—']);
      if (s?.company) rows.push(['Company', s.company]);
      if (s?.position) rows.push(['Role', s.position]);
      if (s?.profileUrl) rows.push(['Profile', \`<a href="\${esc(s.profileUrl)}" target="_blank">Open ↗</a>\`]);
    } else if (src === 'googleContacts') {
      rows.push(['Phone', (s?.phones||[]).join(', ') || (c.phones||[]).join(', ') || '—']);
      rows.push(['Email', (s?.emails||[]).join(', ') || (c.emails||[]).join(', ') || '—']);
      if (s?.org) rows.push(['Org', s.org]);
    } else if (src === 'sms') {
      rows.push(['Phone', s?.phone || (c.phones||[]).join(', ') || '—']);
      if (s?.messageCount) rows.push(['Messages', String(s.messageCount)]);
    } else if (src === 'email') {
      rows.push(['Email', s?.email || (c.emails||[]).join(', ') || '—']);
    }
    return rows;
  }

  const fieldsA = contactFields(cA, srcA);
  const fieldsB = contactFields(cB, srcB);

  const fieldRow = (l, v) => \`<div class="field"><span class="field-label">\${esc(l)}</span>
    <span class="field-value">\${v.startsWith('<') ? v : esc(String(v))}</span></div>\`;

  const HAS_MESSAGES = ['whatsapp', 'sms', 'email'];
  const msgToggleA = (cA && HAS_MESSAGES.includes(srcA))
    ? \`<button class="msg-toggle" onclick="toggleReviewMsgs(this, '\${cA.id}')">Show messages ▾</button><div class="msg-preview" style="display:none"></div>\`
    : '';
  const msgToggleB = (cB && HAS_MESSAGES.includes(srcB))
    ? \`<button class="msg-toggle" onclick="toggleReviewMsgs(this, '\${cB.id}')">Show messages ▾</button><div class="msg-preview" style="display:none"></div>\`
    : '';

  body.innerHTML = \`
    <div class="card">
      <div class="reason-bar">
        <span class="tag \${tagClass}">\${prev || 'pending'}</span>
        <span class="reason-text">\${esc(item.reason)}</span>
      </div>
      <div class="contacts-row">
        <div class="contact-panel">
          <span class="badge badge-\${srcA} panel-badge">\${sourceLabel(srcA)}</span>
          <div class="panel-name">\${esc(item.names?.[0] || item.ids[0])}</div>
          \${fieldsA.map(([l,v]) => fieldRow(l,v)).join('')}
          \${msgToggleA}
        </div>
        <div class="contact-panel">
          <span class="badge badge-\${srcB} panel-badge">\${sourceLabel(srcB)}</span>
          <div class="panel-name">\${esc(item.names?.[1] || item.ids[1])}</div>
          \${fieldsB.map(([l,v]) => fieldRow(l,v)).join('')}
          \${msgToggleB}
        </div>
      </div>
      <div class="actions">
        \${reviewCurrent > 0 ? '<button class="btn-back" onclick="reviewBack()">← <span class="kbd">←</span></button>' : ''}
        <button class="btn-confirm \${sel('confirmed')}" onclick="reviewDecide('confirmed')">✓ Same <span class="kbd">Y</span></button>
        <button class="btn-likely \${sel('likely')}" onclick="reviewDecide('likely')">~ Probably <span class="kbd">L</span></button>
        <button class="btn-unsure \${sel('unsure')}" onclick="reviewDecide('unsure')">? Unsure <span class="kbd">U</span></button>
        <button class="btn-skip \${sel('skip')}" onclick="reviewDecide('skip')">✗ Different <span class="kbd">N</span></button>
      </div>
    </div>
    <div class="merge-output" id="merge-output"></div>
  \`;
}

async function reviewDecide(decision) {
  const item = reviewItems[reviewCurrent];
  if (!item) return;
  await fetch(BASE + '/api/decide', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ idx: item._idx, decision }) });
  reviewDecisions[item._idx] = decision;
  reviewCurrent++;
  renderReview();
  loadReviewCount();
}

function reviewBack() { if (reviewCurrent > 0) { reviewCurrent--; renderReview(); } }

async function toggleReviewMsgs(btn, contactId) {
  const preview = btn.nextElementSibling;
  if (preview.style.display !== 'none') {
    preview.style.display = 'none';
    btn.textContent = 'Show messages ▾';
    return;
  }
  btn.textContent = 'Loading…';
  const data = await fetch(BASE + '/api/contacts/' + contactId + '/interactions').then(r => r.json());
  const msgs = (Array.isArray(data) ? data : (data.interactions || [])).slice(0, 20);
  if (!msgs.length) {
    preview.innerHTML = '<div class="msg-empty">No messages found</div>';
  } else {
    preview.innerHTML = msgs.map(m => {
      const dir = (m.from === 'me' || m.direction === 'sent') ? 'sent' : 'recv';
      const date = m.timestamp ? new Date(m.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '';
      return \`<div class="msg-bubble msg-\${dir}">
        <div class="msg-body">\${esc(m.body || m.subject || '(no content)')}</div>
        <div class="msg-date">\${date}</div>
      </div>\`;
    }).join('');
  }
  preview.style.display = 'block';
  btn.textContent = 'Hide messages ▴';
}

async function runMerge() {
  const out = document.getElementById('merge-output');
  if (out) { out.style.display = 'block'; out.textContent = 'Running…'; }
  const d = await fetch(BASE + '/api/run-merge', { method:'POST' }).then(r => r.json());
  if (out) out.textContent = d.output || d.error || '(no output)';
  // Refresh contact data
  allContacts = await fetch(BASE + '/api/contacts').then(r => r.json());
  applyFilter();
  loadReviewCount();
}

// ============================================================
// Keyboard shortcuts (review)
// ============================================================
document.addEventListener('keydown', e => {
  // Cmd+K / Ctrl+K: open command palette
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    const overlay = document.getElementById('cmd-overlay');
    if (overlay.classList.contains('open')) closePalette();
    else openPalette();
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (document.getElementById('view-review').style.display !== 'none') {
    if (e.key === 'y' || e.key === 'Y') reviewDecide('confirmed');
    else if (e.key === 'n' || e.key === 'N') reviewDecide('skip');
    else if (e.key === 'l' || e.key === 'L') reviewDecide('likely');
    else if (e.key === 'u' || e.key === 'U') reviewDecide('unsure');
    else if (e.key === 'ArrowLeft') reviewBack();
  }
  // Keyboard nav in contacts list
  const contactsVisible = document.getElementById('view-contacts').style.display !== 'none'
                       && !convSearchMode;
  const contactDetailVisible = document.getElementById('view-contact').style.display !== 'none';
  if (contactsVisible && filteredContacts.length > 0) {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (kbCursor < 0) kbCursor = 0;
      else kbCursor = Math.min(kbCursor + 1, filteredContacts.length - 1);
      if (viewMode === 'list') scrollToCursor();
      else { renderList(); document.querySelector('[data-kb="' + kbCursor + '"]')?.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      kbCursor = Math.max(kbCursor - 1, 0);
      if (viewMode === 'list') scrollToCursor();
      else { renderList(); document.querySelector('[data-kb="' + kbCursor + '"]')?.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'Enter' && kbCursor >= 0) {
      e.preventDefault();
      openContact(filteredContacts[kbCursor].id);
    }
  }
  if (e.key === 'Escape') {
    if (document.getElementById('cmd-overlay').classList.contains('open')) { closePalette(); return; }
    if (contactDetailVisible) showView('contacts');
    else if (contactsVisible && kbCursor >= 0) {
      kbCursor = -1;
      if (viewMode === 'list') { document.querySelectorAll('.kb-cursor').forEach(e => e.classList.remove('kb-cursor')); }
      else renderList();
    }
    else showView('contacts');
  }
});

// ============================================================
// Score override
// ============================================================
function toggleScoreOverride(contactId, baseScore, currentVal) {
  const panel = document.getElementById('score-override-panel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

async function saveScoreOverride(contactId, val) {
  const notesEl = document.getElementById('notes-area');
  if (!notesEl) return;
  let notes = notesEl.value || '';
  notes = notes.replace(/\\nscore_override:\\d+/g, '').replace(/score_override:\\d+\\n?/g, '');
  notes = notes.trimEnd() + '\\nscore_override:' + Math.round(val);
  notesEl.value = notes;
  await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(contactId)}/notes\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  });
  const panel = document.getElementById('score-override-panel');
  if (panel) panel.style.display = 'none';
  const chip = document.getElementById('score-chip-val');
  if (chip) chip.textContent = '⚡ ' + Math.round(val) + ' ✎';
}

async function clearScoreOverride(contactId) {
  const notesEl = document.getElementById('notes-area');
  if (!notesEl) return;
  let notes = notesEl.value || '';
  notes = notes.replace(/\\nscore_override:\\d+/g, '').replace(/score_override:\\d+\\n?/g, '').trimEnd();
  notesEl.value = notes;
  await fetch(\`\${BASE}/api/contacts/\${encodeURIComponent(contactId)}/notes\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  });
  const panel = document.getElementById('score-override-panel');
  if (panel) panel.style.display = 'none';
}

// ============================================================
// Command Palette
// ============================================================
const NAV_VIEWS = [
  { label: 'Today',       view: 'today',     icon: '🎯' },
  { label: 'Contacts',    view: 'contacts',  icon: '👥' },
  { label: 'Ask network', view: 'ask',       icon: '🔍' },
  { label: 'Sources',     view: 'sources',   icon: '⚡' },
  { label: 'This Week',   view: 'digest',    icon: '📋' },
  { label: 'Reconnect',   view: 'reconnect', icon: '🔥' },
  { label: 'Communities', view: 'groups',    icon: '💬' },
  { label: 'Network Map', view: 'network',   icon: '🏢' },
  { label: 'Intros',      view: 'intros',    icon: '🤝' },
  { label: 'Review',      view: 'review',    icon: '🔍' },
];

let cmdCursor = -1;
let cmdItems = [];  // flat list of items for arrow nav

function openPalette() {
  const overlay = document.getElementById('cmd-overlay');
  overlay.classList.add('open');
  const input = document.getElementById('cmd-input');
  input.value = '';
  cmdCursor = -1;
  renderCmdResults('');
  setTimeout(() => input.focus(), 20);
}

function closePalette() {
  document.getElementById('cmd-overlay').classList.remove('open');
  cmdCursor = -1;
  cmdItems = [];
}

function onCmdInput(val) {
  cmdCursor = -1;
  renderCmdResults(val.trim().toLowerCase());
}

function onCmdKey(e) {
  if (e.key === 'Escape') { closePalette(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cmdCursor = Math.min(cmdCursor + 1, cmdItems.length - 1);
    updateCmdCursor();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cmdCursor = Math.max(cmdCursor - 1, 0);
    updateCmdCursor();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (cmdCursor >= 0 && cmdItems[cmdCursor]) cmdItems[cmdCursor].action();
    else if (cmdItems.length > 0) cmdItems[0].action();
  }
}

function updateCmdCursor() {
  document.querySelectorAll('.cmd-item').forEach((el, i) => {
    el.classList.toggle('active', i === cmdCursor);
    if (i === cmdCursor) el.scrollIntoView({ block: 'nearest' });
  });
}

function renderCmdResults(q) {
  const results = document.getElementById('cmd-results');
  cmdItems = [];
  let html = '';

  // Nav views
  const matchedViews = NAV_VIEWS.filter(v => !q || v.label.toLowerCase().includes(q));
  if (matchedViews.length) {
    html += '<div class="cmd-section"><div class="cmd-section-label">Views</div>';
    matchedViews.forEach(v => {
      const idx = cmdItems.length;
      cmdItems.push({ action: () => { closePalette(); showView(v.view); } });
      html += \`<div class="cmd-item" data-cmd="\${idx}" onclick="cmdItems[\${idx}].action()">
        <div class="cmd-item-icon">\${v.icon}</div>
        <div class="cmd-item-label">\${esc(v.label)}</div>
        <div class="cmd-item-badge">view</div>
      </div>\`;
    });
    html += '</div>';
  }

  // Contacts (top 8 fuzzy matches)
  if (q && allContacts.length) {
    const matchedContacts = allContacts.filter(c => c.name && c.name.toLowerCase().includes(q)).slice(0, 8);
    if (matchedContacts.length) {
      html += '<div class="cmd-section"><div class="cmd-section-label">Contacts</div>';
      matchedContacts.forEach(c => {
        const idx = cmdItems.length;
        cmdItems.push({ action: () => { closePalette(); openContact(c.id); } });
        const sub = c.company || c.position || '';
        html += \`<div class="cmd-item" data-cmd="\${idx}" onclick="cmdItems[\${idx}].action()">
          <div class="cmd-item-icon" style="background:\${avatarColor(c.id).bg};color:\${avatarColor(c.id).fg};border-radius:50%">\${esc(getInitials(c.name))}</div>
          <div>
            <div class="cmd-item-label">\${esc(c.name)}</div>
            \${sub ? \`<div style="font-size:0.7rem;color:#4a5568">\${esc(sub)}</div>\` : ''}
          </div>
        </div>\`;
      });
      html += '</div>';
    }
  }

  // Companies (top 6 matches)
  if (q && allContacts.length) {
    const compMap = {};
    allContacts.forEach(c => { if (c.company) compMap[c.company] = (compMap[c.company] || 0) + 1; });
    const matchedCos = Object.entries(compMap)
      .filter(([co]) => co.toLowerCase().includes(q))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    if (matchedCos.length) {
      html += '<div class="cmd-section"><div class="cmd-section-label">Companies</div>';
      matchedCos.forEach(([co, count]) => {
        const idx = cmdItems.length;
        cmdItems.push({ action: () => {
          closePalette();
          showView('network');
          setTimeout(() => {
            const inp = document.getElementById('network-search');
            if (inp) { inp.value = co; onNetworkSearch(co); }
          }, 300);
        }});
        html += \`<div class="cmd-item" data-cmd="\${idx}" onclick="cmdItems[\${idx}].action()">
          <div class="cmd-item-icon">🏢</div>
          <div class="cmd-item-label">\${esc(co)}</div>
          <div class="cmd-item-sub">\${count} people</div>
        </div>\`;
      });
      html += '</div>';
    }
  }

  if (!html) html = '<div id="cmd-empty">No results</div>';
  results.innerHTML = html;
}

// ============================================================
// Helpers
// ============================================================
function fmtDaysAgo(days) {
  if (days === null || days === undefined) return '';
  if (days === 0) return 'today';
  if (days < 7)  return days + 'd';
  if (days < 30) return Math.floor(days / 7) + 'w';
  if (days < 365) return Math.floor(days / 30) + 'mo';
  return Math.floor(days / 365) + 'yr';
}

function getInitials(name) {
  if (!name) return '?';
  const words = name.trim().split(/\\s+/);
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = [
  {bg:'#1e3a5f',fg:'#93c5fd'},{bg:'#064e3b',fg:'#6ee7b7'},{bg:'#312e81',fg:'#c4b5fd'},
  {bg:'#431407',fg:'#fb923c'},{bg:'#3b0764',fg:'#e879f9'},{bg:'#0c4a6e',fg:'#38bdf8'},
  {bg:'#422006',fg:'#facc15'},{bg:'#1c1917',fg:'#d6d3d1'},{bg:'#052e16',fg:'#86efac'},
  {bg:'#1e1b4b',fg:'#a5b4fc'},{bg:'#4a044e',fg:'#f0abfc'},{bg:'#0f172a',fg:'#94a3b8'},
];
function avatarColor(id) {
  let h = 0;
  for (let i = 0; i < (id||'').length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function sourceLabel(s) {
  return { whatsapp:'WA', linkedin:'LI', googleContacts:'GC', sms:'SMS', telegram:'TG', email:'Email' }[s] || s;
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Render engagement chips (reply rate, latency, initiation) for the hero card.
// Tolerant of missing metrics — returns empty string so the layout never
// breaks on sparse data.
function renderEngagementChips(m) {
  if (!m || !Array.isArray(m.chips) || m.chips.length === 0) return '';
  const chipHtml = m.chips.map(c => '<span class="engagement-chip">' + esc(c) + '</span>').join('');
  return '<div class="engagement-chips" title="Reply rate / avg latency / who initiates — computed from cross-source interactions">' + chipHtml + '</div>';
}

// Render the "Mentioned by" backlinks panel on the contact detail page.
function renderMentionBacklinks(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const items = list.slice(0, 8).map(b =>
    '<div class="backlink-row" onclick="openContact(\\'' + esc(b.fromId) + '\\')">'
    + '<div class="backlink-from">' + esc(b.fromName || '') + '</div>'
    + '<div class="backlink-snippet">' + esc(b.snippet || '') + '</div>'
    + '</div>'
  ).join('');
  return '<div class="detail-section">'
    + '<h3>Mentioned in</h3>'
    + '<div class="backlinks-list">' + items + '</div>'
    + '</div>';
}

// Client-side mention resolver — mirrors crm/mentions.js but operates over
// the loaded allContacts list so previewing notes doesn't need a roundtrip.
function renderMentionsInline(text) {
  if (!text) return '';
  const MENT = /(^|[\\s(\\[{,;!?])@(?:\"([^\"]+)\"|([A-Za-z][A-Za-z0-9_'-]{0,40}))/g;
  const candidates = [];
  let m;
  MENT.lastIndex = 0;
  while ((m = MENT.exec(text)) !== null) {
    const prefix = m[1] || '';
    const handle = m[2] || m[3];
    if (!handle) continue;
    const start = m.index + prefix.length;
    const length = handle.length + 1 + (m[2] ? 2 : 0);
    candidates.push({ handle, start, length });
  }
  const contacts = allContacts || [];
  const mentions = [];
  for (const c of candidates) {
    let hit = null;
    let actualHandle = c.handle;
    const tryResolve = (h) => {
      const lower = h.toLowerCase();
      const exact = contacts.filter(x => x.name && x.name.toLowerCase() === lower);
      if (exact.length === 1) return { contact: exact[0], confidence: 'exact' };
      const first = contacts.filter(x => x.name && x.name.toLowerCase().split(/\\s+/)[0] === lower);
      if (first.length === 1) return { contact: first[0], confidence: 'first' };
      const starts = contacts.filter(x => x.name && x.name.toLowerCase().startsWith(lower));
      if (starts.length === 1) return { contact: starts[0], confidence: 'starts' };
      return null;
    };
    hit = tryResolve(c.handle);
    if (!hit || hit.confidence !== 'exact') {
      const after = text.slice(c.start + c.length);
      const am = after.match(/^(\\s+[A-Za-z][A-Za-z0-9_'-]{0,40}){1,2}/);
      if (am) {
        const extra = am[0].replace(/^\\s+/, '').split(/\\s+/);
        for (let take = extra.length; take >= 1; take--) {
          const tryH = (c.handle + ' ' + extra.slice(0, take).join(' ')).trim();
          const r = tryResolve(tryH);
          if (r && (r.confidence === 'exact' || !hit)) { hit = r; actualHandle = tryH; if (r.confidence === 'exact') break; }
        }
      }
    }
    if (hit) mentions.push({ contactId: hit.contact.id, contactName: hit.contact.name, start: c.start, length: actualHandle.length + 1 });
  }
  if (mentions.length === 0) return esc(text).replace(/\\n/g, '<br>');
  mentions.sort((a, b) => a.start - b.start);
  const parts = [];
  let i = 0;
  for (const mn of mentions) {
    if (mn.start > i) parts.push(esc(text.slice(i, mn.start)).replace(/\\n/g, '<br>'));
    parts.push('<a class="mention-link" onclick="openContact(\\'' + esc(mn.contactId) + '\\')">@' + esc(mn.contactName || '') + '</a>');
    i = mn.start + mn.length;
  }
  if (i < text.length) parts.push(esc(text.slice(i)).replace(/\\n/g, '<br>'));
  return parts.join('');
}

// Safe for interpolation inside a JS single-quoted string inside an HTML
// double-quoted attribute, e.g. onclick="fn('\${jsAttr(x)}')". The browser
// HTML-decodes the attribute before the JS parser sees it, so we JS-escape
// first, then HTML-escape. esc() alone is NOT safe in this position.
function jsAttr(s) {
  // NOTE: this whole <script> is inside the server-side \`const HTML = \\\`...\\\`\`
  // template literal. Every \\ in THIS source is halved by Node before the
  // browser sees it. So to produce a browser-visible regex \\\\ (matching one
  // backslash) we need \\\\\\\\ in source; to produce a browser-visible string
  // \\\\\\\\ (two backslashes) we need \\\\\\\\\\\\\\\\ in source. Same for \\r / \\n.
  const jsEscaped = String(s||'')
    .replace(/\\\\/g, '\\\\\\\\')
    .replace(/'/g, "\\\\'")
    .replace(/\\r/g, '\\\\r')
    .replace(/\\n/g, '\\\\n');
  return jsEscaped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// ============================================================
// Ask view — natural language network query
// ============================================================

let askEnhanceTimer = null;

function setAskQuery(q) {
  const input = document.getElementById('ask-input');
  if (input) { input.value = q; input.focus(); runAskQuery(); }
}

async function runAskQuery() {
  const input = document.getElementById('ask-input');
  const el    = document.getElementById('ask-results');
  if (!input || !el) return;
  const q = input.value.trim();
  if (!q) return;

  if (askEnhanceTimer) { clearTimeout(askEnhanceTimer); askEnhanceTimer = null; }

  // Show skeleton while loading
  el.innerHTML = \`
    <div class="ask-skeleton"></div>
    <div class="ask-skeleton" style="height:80px;opacity:0.7"></div>
    <div class="ask-skeleton" style="height:80px;opacity:0.4"></div>
    <div class="ask-thinking">Thinking about your network…</div>
  \`;

  try {
    // Layer 2: instant results
    const r = await fetch(BASE + '/api/network/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    }).then(r => r.json());

    renderAskResults(el, r, false);

    // Layer 3: Claude-enhanced results (async, ~10s)
    askEnhanceTimer = setTimeout(async () => {
      try {
        const enhanced = await fetch(BASE + '/api/network/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, enhance: true }),
        }).then(r => r.json());
        if (enhanced.enhanced && enhanced.results && enhanced.results.length > 0) {
          renderAskResults(el, enhanced, true);
        }
      } catch { /* Claude unavailable — keep instant results */ }
    }, 100);

  } catch (e) {
    el.innerHTML = \`<div style="color:var(--health-cold);padding:20px;text-align:center">Query failed: \${esc(e.message)}</div>\`;
  }
}

function renderAskResults(el, data, enhanced) {
  if (!data || !data.results) { el.innerHTML = ''; return; }

  const results = data.results || [];
  if (results.length === 0) {
    el.innerHTML = \`<div style="text-align:center;padding:40px;color:var(--text-muted)">
      No matches found in your network.<br>
      <span style="font-size:0.8rem">Try a different role, city, or intent.</span>
    </div>\`;
    return;
  }

  const descHtml = data.description
    ? \`<div class="ask-description">\${esc(data.description)}</div>\`
    : '';
  const enhancedBadge = enhanced
    ? '<span style="float:right;font-size:0.65rem;color:var(--accent);font-weight:600">✦ AI ranked</span>'
    : '';

  const cardsHtml = results.map(c => {
    const col   = avatarColor(c.id);
    const ring  = healthRingHTML(c.relationshipScore || 0, 48);
    const initials = esc(getInitials(c.name || '?'));
    const scoreColor = (c.relationshipScore || 0) >= 70 ? '#22c55e'
        : (c.relationshipScore || 0) >= 40 ? '#84cc16'
        : (c.relationshipScore || 0) >= 20 ? '#f59e0b'
        : (c.relationshipScore || 0) > 0   ? '#f97316' : '#374151';
    const days = c.daysSinceContact ? (c.daysSinceContact > 365 ? '1yr+' : c.daysSinceContact > 30 ? Math.round(c.daysSinceContact / 30) + 'mo' : c.daysSinceContact + 'd') : 'never';

    const cityTag   = c.city   ? \`<span class="ask-result-tag city">\${esc(c.city.charAt(0).toUpperCase()+c.city.slice(1))}</span>\` : '';
    const rolesHtml = (c.roles || []).slice(0, 2).map(r => \`<span class="ask-result-tag role">\${esc(r)}</span>\`).join('');
    const reasonHtml = c.reason
      ? \`<div class="ask-result-reason">\${esc(c.reason)}</div>\`
      : '';
    const reasonChipsHtml = Array.isArray(c.reasons) && c.reasons.length
      ? '<div class="ask-result-reasons">' + c.reasons.slice(0, 5).map(r =>
          '<span class="ask-reason-chip ' + esc(r.kind) + '">' +
            '<span class="ask-reason-kind">' + esc(r.label) + '</span>' +
            (r.detail ? '<span class="ask-reason-detail">· ' + esc(r.detail) + '</span>' : '') +
          '</span>'
        ).join('') + '</div>'
      : '';

    return \`<div class="ask-result-card" onclick="openContact('\${esc(c.id)}')">
      <div class="ask-result-avatar">
        \${ring}
        <div style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.78rem;font-weight:600;position:absolute;top:3px;left:3px;background:\${col.bg};color:\${col.fg}">\${initials}</div>
      </div>
      <div class="ask-result-body">
        <div class="ask-result-name">\${esc(c.name || '(no name)')}</div>
        <div class="ask-result-role">\${esc([c.title, c.company].filter(Boolean).join(' · ') || '–')}</div>
        <div class="ask-result-meta">
          \${cityTag}\${rolesHtml}
          <span class="ask-result-tag">\${days === 'never' ? 'never contacted' : days + ' ago'}</span>
        </div>
        \${reasonHtml}
        \${reasonChipsHtml}
        <div class="ask-result-actions">
          <button class="ask-btn-primary" onclick="event.stopPropagation();openContact('\${esc(c.id)}')">View profile</button>
          <button class="ask-btn-secondary" onclick="event.stopPropagation();openContact('\${esc(c.id)}');setTimeout(()=>document.getElementById('draft-panel')?.style.setProperty('display','flex'),300)">Draft message</button>
        </div>
      </div>
      <div class="ask-result-score">
        <span class="ask-result-score-num" style="color:\${scoreColor}">\${c.relationshipScore || 0}</span>
        <span style="font-size:0.65rem;color:var(--text-muted)">score</span>
      </div>
    </div>\`;
  }).join('');

  el.innerHTML = descHtml + enhancedBadge + \`<div class="ask-results">\${cardsHtml}</div>\`;
}

// ============================================================
// Sources view
// ============================================================

const SOURCE_META = {
  linkedin:      { icon: '💼', name: 'LinkedIn', fileSource: true,
    desc: 'Import your connections and message history.',
    tip: 'Go to <a href="https://www.linkedin.com/mypreferences/d/download-my-data" target="_blank">linkedin.com → Settings → Data Privacy → Get a copy of your data</a>, request <b>Connections</b>, then upload <code>Connections.csv</code> from the email they send.' },
  email:         { icon: '📧', name: 'Email',
    desc: "See every contact you've emailed and when.",
    tip: 'For Gmail: go to <a href="https://myaccount.google.com/apppasswords" target="_blank">myaccount.google.com/apppasswords</a> to create an App Password (requires 2FA). Use <code>imap.gmail.com</code> as the host.' },
  whatsapp:      { icon: '💬', name: 'WhatsApp',
    desc: 'Real-time message sync via linked device.',
    tip: 'On your phone: open <b>WhatsApp → ⋮ Menu → Linked Devices → Link a Device</b>, then scan the QR code.' },
  googleContacts:{ icon: '📒', name: 'Google Contacts',
    desc: 'Your Google Contacts, always in sync.',
    tip: 'To upload manually: go to <a href="https://contacts.google.com" target="_blank">contacts.google.com</a> → Export → vCard format, then upload the .vcf file.' },
  telegram:      { icon: '✈️',  name: 'Telegram', fileSource: true,
    desc: 'Upload result.json from Telegram Desktop export.',
    tip: 'Telegram Desktop → Settings → Advanced → Export Telegram Data → select JSON format.' },
  sms:           { icon: '📱', name: 'SMS', fileSource: true,
    desc: 'Upload XML from SMS Backup & Restore app.',
    tip: 'Use the "SMS Backup & Restore" Android app to export an XML file.' },
};

let sourceStatuses = {};
let syncStatuses = {};
let waPoller = null;
let sourcesRefreshTimer = null;

// Browser-side relative time formatter (mirrors server-side formatSyncAge in utils.js)
function fmtSyncAge(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
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

function getSyncDotClass(key) {
  const s = syncStatuses[key];
  if (!s) return 'sync-dot-idle';
  if (s.status === 'error') return 'sync-dot-error';
  if (s.status === 'syncing' || s.status === 'active') return 'sync-dot-active';
  if (s.status === 'stale') return 'sync-dot-stale';
  if (!s.lastSyncAt) return 'sync-dot-idle';
  const ms = Date.now() - new Date(s.lastSyncAt).getTime();
  const threshold = SOURCE_META[key]?.fileSource ? 30 * 86400 * 1000 : 24 * 3600 * 1000;
  return ms > threshold ? 'sync-dot-stale' : 'sync-dot-ok';
}

async function loadSettings() {
  const el = document.getElementById('settings-body');
  if (!el) return;
  el.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const s = await fetch(BASE + '/api/settings').then(r => r.json());
    el.innerHTML = renderSettings(s);
  } catch (e) {
    el.innerHTML = '<div style="color:#ef4444">Failed to load: ' + esc(e.message) + '</div>';
  }
}

function renderSettings(s) {
  const isDemo = s.currentMode === 'demo';
  const otherMode = isDemo ? 'real' : 'demo';
  const otherLabel = isDemo ? 'Real data' : 'Demo data';
  const demoStat = s.demo.contacts ? s.demo.contacts + ' contacts · ' + s.demo.interactions + ' interactions' : 'not seeded yet';
  const realStat = s.real.contacts ? s.real.contacts + ' contacts · ' + s.real.interactions + ' interactions' : 'no data imported';

  const envOverrideNote = s.envOverride
    ? '<div class="settings-note settings-note-warn">Mode is being forced via an env var (CRM_DATA_DIR or MINTY_DEMO). Clear the env to let this setting take effect.</div>'
    : '';

  return \`
    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-label">Current mode</div>
        <div class="settings-row-value">
          <span class="settings-mode-badge \${isDemo ? 'demo' : 'real'}">\${esc(s.currentMode)}</span>
          <span style="color:var(--text-muted);font-size:11px;margin-left:8px">\${esc(s.dataDir)}</span>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Real data</div>
        <div class="settings-row-value" style="font-size:11px;color:var(--text-secondary)">\${esc(realStat)}</div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Demo data</div>
        <div class="settings-row-value" style="font-size:11px;color:var(--text-secondary)">
          \${esc(demoStat)}
          <button class="settings-btn settings-btn-secondary" style="margin-left:10px" onclick="seedDemo()">Regenerate</button>
        </div>
      </div>
      \${envOverrideNote}
      <div class="settings-actions">
        <button class="settings-btn" onclick="setMode('\${otherMode}')">Switch to \${otherLabel}</button>
      </div>
    </div>

    \${renderLinkedinAutosyncCard(s)}
    \${renderGoogleOAuthCard(s)}

    <div class="settings-card">
      <div class="settings-card-title">About</div>
      <div class="settings-row"><div class="settings-row-label">Version</div><div class="settings-row-value">\${esc(s.dataDir.split('/').pop())} · v\${esc((window.__BASE__ || '') || 'dev')}</div></div>
      <div class="settings-row" style="font-size:11px;color:var(--text-muted)">
        Demo mode keeps a separate ./data-demo directory so synthetic fixtures
        never touch your real WhatsApp/email/etc. Switching modes requires a
        server restart — Minty surfaces the command for you.
      </div>
    </div>
  \`;
}

function renderLinkedinAutosyncCard(s) {
  const cfg = s.runtimeConfig || {};
  const enabled = !!cfg.linkedinAutosync;
  const envForced = !!cfg.envForces?.linkedinAutosync;
  const pwAvailable = !!s.playwrightAvailable;

  const badge = enabled
    ? '<span class="settings-mode-badge real">enabled</span>'
    : '<span class="settings-mode-badge demo">disabled</span>';

  const envNote = envForced
    ? '<div class="settings-note settings-note-warn">MINTY_LINKEDIN_AUTOSYNC env var is set — unset it to control from the UI.</div>'
    : '';

  const pwNote = !pwAvailable
    ? '<div class="settings-note settings-note-warn">Playwright not installed — run <code>npm run linkedin:setup</code> in your terminal first.</div>'
    : '';

  const blocked = envForced || !pwAvailable;
  const action = enabled
    ? '<button class="settings-btn settings-btn-secondary" onclick="setLinkedinAutosync(false)">Disable</button>'
    : '<button class="settings-btn" onclick="setLinkedinAutosync(true)"' + (blocked ? ' disabled' : '') + '>Enable</button>';

  return \`
    <div class="settings-card">
      <div class="settings-card-title">LinkedIn auto-sync</div>
      <div class="settings-row">
        <div class="settings-row-label">Status</div>
        <div class="settings-row-value">\${badge}</div>
      </div>
      <div class="settings-row" style="font-size:11px;color:var(--text-muted)">
        Pulls connections + messages on a 24h schedule via a headless browser.
        Experimental and ToS-adjacent. Requires <code>npm run linkedin:connect</code>
        once to authenticate.
      </div>
      \${pwNote}
      \${envNote}
      <div class="settings-actions">\${action}</div>
    </div>
  \`;
}

function renderGoogleOAuthCard(s) {
  const c = s.runtimeConfig?.google || {};
  const envIdForced = !!s.runtimeConfig?.envForces?.google?.clientId;
  const envSecretForced = !!s.runtimeConfig?.envForces?.google?.clientSecret;
  const idVal = c.clientId ? esc(c.clientId) : '';
  const secretPlaceholder = c.clientSecretSet ? c.clientSecretMasked : '';
  return \`
    <div class="settings-card">
      <div class="settings-card-title">Google OAuth (Gmail · Calendar · Contacts)</div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <label style="font-size:11px;color:var(--text-muted)">Client ID \${envIdForced ? '<span style="color:#b45309">(set via env)</span>' : ''}</label>
        <input id="g-client-id" type="text" value="\${idVal}" \${envIdForced ? 'disabled' : ''} placeholder="123-abc.apps.googleusercontent.com" style="padding:8px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;font-size:12px;font-family:monospace">
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <label style="font-size:11px;color:var(--text-muted)">Client Secret \${envSecretForced ? '<span style="color:#b45309">(set via env)</span>' : ''}</label>
        <input id="g-client-secret" type="password" placeholder="\${secretPlaceholder || 'GOCSPX-…'}" \${envSecretForced ? 'disabled' : ''} style="padding:8px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;font-size:12px;font-family:monospace">
      </div>
      <div class="settings-row" style="font-size:11px;color:var(--text-muted)">
        Get credentials from <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console → Credentials</a>.
        Leave secret blank to keep the previously-saved value.
      </div>
      <div class="settings-actions">
        <button class="settings-btn" onclick="saveGoogleOAuth()" \${envIdForced && envSecretForced ? 'disabled' : ''}>Save</button>
      </div>
    </div>
  \`;
}

async function setLinkedinAutosync(enabled) {
  const r = await fetch(BASE + '/api/settings/linkedin-autosync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(r => r.json());
  if (r.error) { alert(r.error); return; }
  loadSettings();
}

async function saveGoogleOAuth() {
  const clientId = document.getElementById('g-client-id')?.value.trim();
  const clientSecret = document.getElementById('g-client-secret')?.value;
  const r = await fetch(BASE + '/api/settings/oauth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'google', clientId, clientSecret }),
  }).then(r => r.json());
  if (r.error) { alert(r.error); return; }
  loadSettings();
}

async function setMode(mode) {
  const r = await fetch(BASE + '/api/settings/mode', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  }).then(r => r.json());
  if (r.error) { alert(r.error); return; }
  if (r.restartRequired) {
    alert('Mode saved as "' + r.savedMode + '". Restart Minty to apply:\\n\\n  Stop the current process (Ctrl+C in the terminal),\\n  then run:  npm run crm');
  }
  loadSettings();
}

async function seedDemo() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Regenerating…';
  try {
    const r = await fetch(BASE + '/api/settings/seed-demo', { method: 'POST' }).then(r => r.json());
    if (r.error) { alert('Failed: ' + r.error); }
    loadSettings();
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Regenerate'; }
}

async function loadSources() {
  const [sourcesData, syncData] = await Promise.all([
    fetch(BASE + '/api/sources').then(r => r.json()),
    fetch(BASE + '/api/sync/status').then(r => r.json()).catch(() => ({})),
  ]);
  sourceStatuses = sourcesData;
  syncStatuses = syncData;
  renderSources();
  updateSyncStatusBar();
}

function makeSourceCard(key, meta) {
  const status = sourceStatuses[key] || {};
  const syncState = syncStatuses[key] || {};
  const connected = !!(status.hasData || status.status === 'connected' || status.status === 'done');
  const card = document.createElement('div');
  card.className = 'source-card';
  card.id = 'source-card-' + key;
  const isConnecting = status.status === 'qr_pending' || status.status === 'initializing' || status.status === 'authenticated';
  const statusLabel = connected ? 'Connected' : (isConnecting ? 'Connecting…' : 'Not connected');
  const statusClass = connected ? 'connected' : (isConnecting ? 'pending' : 'idle');
  const dotClass = connected || isConnecting ? getSyncDotClass(key) : 'sync-dot-idle';

  // Meta line: last synced + contact count
  const lastSynced = fmtSyncAge(syncState.lastSyncAt);
  const count = status.contactCount;
  const metaParts = [];
  if (lastSynced) metaParts.push('Synced ' + lastSynced);
  else if (connected) metaParts.push('Watching for changes');
  if (count != null) metaParts.push(count.toLocaleString() + ' contacts');
  const metaLine = metaParts.length ? \`<div class="source-meta">\${metaParts.join(' · ')}</div>\` : '';

  const tip = meta.tip && !connected ? \`
    <details style="margin-bottom:12px">
      <summary style="font-size:0.72rem;color:#4b5563;cursor:pointer;list-style:none;display:flex;align-items:center;gap:5px;user-select:none;-webkit-user-select:none">
        <span style="font-size:0.5rem;opacity:0.5">▶</span> How to connect
      </summary>
      <div class="source-tip" style="margin-top:8px;margin-bottom:0">\${meta.tip}</div>
    </details>\` : '';

  card.innerHTML = \`
    <div class="source-card-header">
      <div class="sync-dot \${dotClass}"></div>
      <span class="source-icon">\${meta.icon}</span>
      <div style="flex:1;min-width:0">
        <div class="source-name">\${meta.name}</div>
        \${metaLine}
      </div>
      <span class="source-status \${statusClass}">\${statusLabel}</span>
    </div>
    \${!connected && !isConnecting ? '<div class="source-desc">' + meta.desc + '</div>' : ''}
    \${tip}
    <div id="source-form-\${key}"></div>
  \`;
  return card;
}

function renderSources() {
  const grid = document.getElementById('sources-grid');
  grid.innerHTML = '';
  const isConnected = key => !!(sourceStatuses[key]?.hasData || sourceStatuses[key]?.status === 'connected' || sourceStatuses[key]?.status === 'done');
  for (const [key, meta] of Object.entries(SOURCE_META)) {
    grid.appendChild(makeSourceCard(key, meta));
    renderSourceForm(key, sourceStatuses[key] || {}, isConnected(key));
  }
}

async function triggerSync(key) {
  const card = document.getElementById('source-card-' + key);
  const btn = card?.querySelector('.sync-now-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    await fetch(BASE + '/api/sync/trigger/' + key, { method: 'POST' });
  } catch (_) { /* ignore */ }
  await loadSources();
}

function updateSyncStatusBar() {
  const bar = document.getElementById('sync-status-bar');
  if (!bar) return;
  const LABELS = { whatsapp: 'WhatsApp', email: 'Email', googleContacts: 'Google Contacts', linkedin: 'LinkedIn', telegram: 'Telegram', sms: 'SMS' };
  let state = 'ok', message = 'All sources current';
  for (const [key, s] of Object.entries(syncStatuses)) {
    if (!LABELS[key]) continue;
    if (s.status === 'error') { state = 'error'; message = LABELS[key] + ' sync error — check Sources'; break; }
  }
  if (state === 'ok') {
    for (const [key, s] of Object.entries(syncStatuses)) {
      if (!LABELS[key]) continue;
      if (s.status === 'stale') { state = 'stale'; message = LABELS[key] + ' is outdated — refresh?'; break; }
    }
  }
  const dotColor = state === 'ok' ? '#22c55e' : state === 'stale' ? '#f59e0b' : '#ef4444';
  bar.innerHTML = \`<div style="display:flex;align-items:center;gap:7px">
    <div style="width:6px;height:6px;border-radius:50%;background:\${dotColor};flex-shrink:0"></div>
    <span style="font-size:0.67rem;color:#4b5563;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${message}</span>
  </div>\`;
}

function renderSourceForm(key, status, connected) {
  const el = document.getElementById('source-form-' + key);
  if (!el) return;

  if (key === 'email') {
    const accounts = status.accounts || [];
    const hasAccounts = accounts.length > 0;
    const accountList = accounts.map(a => \`
      <div class="source-row">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          \${a.provider === 'google'
            ? '<svg width="13" height="13" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>'
            : '<svg width="13" height="13" viewBox="0 0 24 24" style="flex-shrink:0"><rect width="11" height="11" x="1" y="1" fill="#f25022"/><rect width="11" height="11" x="13" y="1" fill="#7fba00"/><rect width="11" height="11" x="1" y="13" fill="#00a4ef"/><rect width="11" height="11" x="13" y="13" fill="#ffb900"/></svg>'}
          <span style="font-size:0.8rem;color:#8892a4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${a.email}</span>
        </div>
        <button class="source-btn secondary" style="font-size:0.7rem;padding:3px 9px;flex-shrink:0" onclick="removeEmailAccount('\${a.email}')">Remove</button>
      </div>\`).join('');

    const gmailBtn = sourceStatuses._googleOAuthEnabled
      ? \`<button class="source-btn" style="display:flex;align-items:center;gap:8px;justify-content:center;width:100%" onclick="startEmailDevice('google')">
          <svg width="14" height="14" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          \${hasAccounts ? 'Add another Gmail account' : 'Connect Gmail'}
        </button>\`
      : '';

    const outlookBtn = sourceStatuses._microsoftOAuthEnabled
      ? \`<button class="source-btn secondary" style="display:flex;align-items:center;gap:8px;justify-content:center;width:100%" onclick="startEmailDevice('microsoft')">
          <svg width="14" height="14" viewBox="0 0 24 24"><rect width="11" height="11" x="1" y="1" fill="#f25022"/><rect width="11" height="11" x="13" y="1" fill="#7fba00"/><rect width="11" height="11" x="1" y="13" fill="#00a4ef"/><rect width="11" height="11" x="13" y="13" fill="#ffb900"/></svg>
          \${hasAccounts ? 'Add Outlook account' : 'Connect Outlook'}
        </button>\`
      : '';

    const noBtns = !sourceStatuses._googleOAuthEnabled && !sourceStatuses._microsoftOAuthEnabled
      ? \`<div style="font-size:0.74rem;color:#4b5563">Set GOOGLE_CLIENT_ID or MICROSOFT_CLIENT_ID in .env to enable OAuth</div>\`
      : '';

    const syncNow = hasAccounts
      ? \`<button class="source-btn secondary sync-now-btn" style="width:100%;margin-top:6px" onclick="triggerSync('email')">Sync inbox now</button>\`
      : '';

    el.innerHTML = \`
      \${accountList}
      \${accountList ? '<div style="height:8px"></div>' : ''}
      <div style="display:flex;flex-direction:column;gap:6px">\${gmailBtn}\${outlookBtn}\${noBtns}</div>
      \${syncNow}
      <div id="email-device-ui" style="margin-top:8px"></div>
      <details style="margin-top:12px">
        <summary style="font-size:0.72rem;color:#4b5563;cursor:pointer;list-style:none;display:flex;align-items:center;gap:5px;user-select:none;-webkit-user-select:none">
          <span style="font-size:0.5rem;opacity:0.5">▶</span> Use IMAP instead
        </summary>
        <div class="source-form" style="margin-top:10px">
          <input id="email-user" placeholder="Email address" oninput="emailAutoHost(this.value)" />
          <input id="email-host" placeholder="IMAP host (auto-filled for Gmail/Outlook)" />
          <input id="email-pass" type="password" placeholder="App password" />
          <button class="source-btn secondary" onclick="connectEmail()">Connect via IMAP</button>
          <div class="source-log" id="email-log"></div>
        </div>
      </details>\`;
    return;
  }

  if (connected) {
    if (key === 'whatsapp') {
      const msgCount = syncStatuses.whatsapp?.messageCount;
      el.innerHTML = \`
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <span style="font-size:0.76rem;color:#34d399">● Live — receiving messages\${msgCount ? ' · ' + msgCount.toLocaleString() + ' synced' : ''}</span>
          <button class="source-btn secondary" style="font-size:0.7rem;padding:4px 10px" onclick="reconnectSource('whatsapp')">Reconnect</button>
        </div>\`;
      return;
    }
    const importDate = status.connectedAt ? new Date(status.connectedAt).toLocaleDateString() : null;
    const watchingNote = SOURCE_META[key]?.fileSource
      ? \`<span style="font-size:0.7rem;color:#4b5563">Watching for changes</span>\`
      : \`<span style="font-size:0.76rem;color:#34d399">✓ Imported\${importDate ? ' · ' + importDate : ''}</span>\`;
    el.innerHTML = \`
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        \${watchingNote}
        <div style="display:flex;gap:6px">
          <button class="source-btn secondary sync-now-btn" style="font-size:0.7rem;padding:4px 10px" onclick="triggerSync('\${key}')">Sync now</button>
          <button class="source-btn secondary" style="font-size:0.7rem;padding:4px 10px" onclick="reconnectSource('\${key}')">Re-import</button>
        </div>
      </div>\`;
    return;
  }

  if (key === 'whatsapp') {
    const waStatus = status.status || 'not_started';
    if (waStatus === 'qr_pending' || waStatus === 'initializing' || waStatus === 'authenticated') {
      el.innerHTML = \`<div class="source-log">Waiting for QR code…</div>
        <div class="source-qr" id="wa-qr-container"></div>
        <div class="source-log" id="wa-export-log" style="margin-top:8px"></div>\`;
      startWaPoller();
      return;
    }
    if (waStatus === 'ready') {
      el.innerHTML = \`<div class="source-log">Connected — exporting chats…</div>
        <div class="source-log" id="wa-export-log" style="margin-top:4px"></div>\`;
      startWaPoller();
      return;
    }
    el.innerHTML = \`<button class="source-btn" style="width:100%" onclick="startWhatsapp()">Scan QR code</button>
      <div class="source-log" id="wa-log"></div>\`;
    return;
  }

  if (key === 'googleContacts') {
    const hasGmail = (sourceStatuses.email?.accounts || []).some(a => a.provider === 'google');
    const gcStatus = sourceStatuses.googleContacts || {};
    const gcSynced = gcStatus.syncedAt;
    const gcCount = gcStatus.count;
    if (hasGmail) {
      el.innerHTML = \`
        <div class="source-row">
          <span style="font-size:0.76rem;color:#4b5563">\${gcSynced ? gcCount.toLocaleString() + ' contacts · ' + new Date(gcSynced).toLocaleDateString() : 'Not yet synced'}</span>
          <button class="source-btn secondary" style="font-size:0.7rem;padding:3px 10px;flex-shrink:0" id="gc-sync-btn" onclick="syncGoogleContacts()">\${gcSynced ? 'Sync' : 'Import'}</button>
        </div>
        <div id="gc-sync-log" class="source-log" style="margin-top:4px"></div>\`;
    } else {
      el.innerHTML = \`
        <label class="drop-zone" id="dz-googleContacts" ondragover="dzOver(event,'googleContacts')" ondragleave="dzLeave('googleContacts')" ondrop="dzDrop(event,'googleContacts')">
          <div style="margin-bottom:4px">Drop contacts.vcf or <u>browse</u></div>
          <div style="font-size:0.7rem;color:#374151;margin-top:2px">Export from contacts.google.com → Export → vCard</div>
          <input type="file" id="file-googleContacts" accept=".vcf" onchange="uploadSource('googleContacts', this.files)">
        </label>
        <div class="source-log" id="log-googleContacts"></div>\`;
      document.getElementById('dz-googleContacts')?.addEventListener('click', () => document.getElementById('file-googleContacts')?.click());
    }
    return;
  }

  if (key === 'linkedin') {
    const li = sourceStatuses._linkedin || { status: 'disconnected' };
    const autoEnabled = !!sourceStatuses._linkedinAutoSyncEnabled;
    const pwMissing = autoEnabled && !sourceStatuses._linkedin?.playwrightAvailable && li.status !== 'disconnected';
    const showAutoCard = autoEnabled && (li.status === 'connected' || li.status === 'syncing' || li.status === 'challenge' || li.status === 'error');
    if (showAutoCard) {
      const copy = {
        connected: li.lastSync ? 'Synced · ' + new Date(li.lastSync).toLocaleDateString() : 'Connected — no data yet',
        syncing: li.progress ? 'Syncing · ' + li.progress.phase + ' ' + li.progress.current + '/' + li.progress.total : 'Syncing…',
        challenge: 'Action needed — reconnect',
        error: 'Sync failed' + (li.lastError?.message ? ' — ' + li.lastError.message : ''),
      }[li.status] || 'Connected';
      const color = (li.status === 'error' || li.status === 'challenge') ? '#f87171' : (li.status === 'syncing' ? '#fbbf24' : '#34d399');
      const cta = li.status === 'challenge' ? '<button class="source-btn secondary" style="font-size:0.7rem;padding:4px 10px" onclick="connectLinkedIn()">Reconnect</button>'
                : '<button class="source-btn secondary sync-now-btn" style="font-size:0.7rem;padding:4px 10px" onclick="syncLinkedIn()" ' + (li.status === 'syncing' ? 'disabled' : '') + '>Sync now</button>';
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">'
        + '<span style="font-size:0.76rem;color:' + color + '">● ' + copy + '</span>' + cta + '</div>'
        + '<div style="margin-top:8px;font-size:0.7rem"><a href="#" onclick="event.preventDefault();switchLinkedInMode(\\'zip\\')" style="color:#6366f1">Prefer the safer ZIP import? Switch to file upload</a></div>';
      if (li.status === 'syncing') startLinkedInPoll();
      return;
    }
    // ZIP mode (default)
    const zipBtn = '<input type="file" id="file-linkedin" accept="*" multiple style="display:none" onchange="uploadSource(\\'linkedin\\', this.files)">'
      + '<button class="source-btn secondary" style="width:100%" onclick="document.getElementById(\\'file-linkedin\\').click()">Choose file — Connections.csv, messages.csv, Invitations.csv</button>'
      + '<label class="drop-zone" id="dz-linkedin" ondragover="dzOver(event,\\'linkedin\\')" ondragleave="dzLeave(\\'linkedin\\')" ondrop="dzDrop(event,\\'linkedin\\')" style="margin-top:6px;padding:10px;font-size:0.72rem">or drop here</label>'
      + '<div class="source-log" id="log-linkedin"></div>';
    let footer;
    if (!autoEnabled) {
      // Most-discoverable state: ZIP upload is shown, but tell the user the
      // browser-based auto-sync alternative exists and where to enable it.
      footer = '<div style="margin-top:10px;font-size:0.7rem;color:#8892a4">Prefer auto-sync via headless browser? <a href="#" onclick="event.preventDefault();showView(\\'settings\\')" style="color:#6366f1">Enable in Settings</a> (experimental — ToS-adjacent).</div>';
    } else if (pwMissing) {
      footer = '<div style="margin-top:10px;font-size:0.7rem;color:#8892a4">Auto-sync needs Playwright. Run <code>npm run linkedin:setup</code> in your terminal.</div>';
    } else if (li.status === 'disconnected') {
      // Auto-sync enabled but no session yet — guide to the connect flow.
      footer = '<div style="margin-top:10px;font-size:0.7rem"><a href="#" onclick="event.preventDefault();connectLinkedIn()" style="color:#6366f1">Connect via browser to start auto-sync</a></div>';
    } else {
      footer = '';
    }
    el.innerHTML = zipBtn + footer;
    return;
  }

  // File upload sources (Telegram, SMS)
  const accept = key === 'telegram' ? '.json' : key === 'sms' ? '.xml' : '*';
  const fileLabel = key === 'telegram' ? 'result.json' : 'XML backup file';
  el.innerHTML = \`
    <input type="file" id="file-\${key}" accept="\${accept}" multiple style="display:none" onchange="uploadSource('\${key}', this.files)">
    <button class="source-btn secondary" style="width:100%" onclick="document.getElementById('file-\${key}').click()">Choose file — \${fileLabel}</button>
    <label class="drop-zone" id="dz-\${key}" ondragover="dzOver(event,'\${key}')" ondragleave="dzLeave('\${key}')" ondrop="dzDrop(event,'\${key}')" style="margin-top:6px;padding:10px;font-size:0.72rem">
      or drop here
    </label>
    <div class="source-log" id="log-\${key}"></div>\`;
}

let _liPoll = null;
function startLinkedInPoll() {
  if (_liPoll) return;
  _liPoll = setInterval(async () => {
    await loadSources();
    const s = sourceStatuses._linkedin?.status;
    if (s !== 'syncing') { clearInterval(_liPoll); _liPoll = null; }
  }, 5000);
}
async function syncLinkedIn() {
  const r = await fetch(BASE + '/api/linkedin/sync', { method: 'POST', credentials: 'same-origin' });
  if (r.status === 403) return alert('CSRF check failed. Reload the page and try again.');
  if (r.status === 503) return alert('Playwright not installed. Run: npm run linkedin:setup');
  if (r.status === 409) return alert('A sync is already in progress.');
  if (r.status === 400) return alert('Connect LinkedIn first (Enable auto-sync).');
  await loadSources();
  startLinkedInPoll();
}
async function connectLinkedIn() {
  if (!confirm('This opens a Chromium window on this machine for you to log into LinkedIn. Continue?')) return;
  const r = await fetch(BASE + '/api/linkedin/connect', { method: 'POST', credentials: 'same-origin' });
  if (r.status === 403) return alert('CSRF check failed. Reload and try again.');
  if (r.status === 503) return alert('Playwright not installed. Run: npm run linkedin:setup');
  if (r.status === 409) return alert('A sync is already running. Wait for it to finish.');
  alert('Chromium window should be opening on this machine. Log into LinkedIn there, then close the window.');
}
function switchLinkedInMode(/* mode */) {
  alert('Mode switching is not persisted in Phase 1. For the ZIP flow, use: npm run linkedin:import-zip');
}

function reconnectSource(key) { renderSourceForm(key, {}, false); }

function dzOver(e, key) { e.preventDefault(); document.getElementById('dz-' + key)?.classList.add('drag-over'); }
function dzLeave(key) { document.getElementById('dz-' + key)?.classList.remove('drag-over'); }
function dzDrop(e, key) {
  e.preventDefault();
  dzLeave(key);
  uploadSource(key, e.dataTransfer.files);
}

async function uploadSource(key, files) {
  if (!files?.length) return;
  const log = document.getElementById('log-' + key);
  if (log) log.textContent = 'Uploading and importing...';

  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name);

  try {
    const r = await fetch(BASE + '/api/sources/upload/' + key, { method: 'POST', body: fd });
    const d = await r.json();
    if (d.ok) {
      if (log) log.textContent = '✓ Imported successfully';
      await loadSources();
    } else {
      if (log) log.textContent = '✗ Error: ' + d.error;
    }
  } catch (e) {
    if (log) log.textContent = '✗ ' + e.message;
  }
}

async function removeEmailAccount(email) {
  await fetch(BASE + '/api/sources/email/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  await loadSources();
}

let emailDevicePoller = null;

async function startEmailDevice(provider) {
  const ui = document.getElementById('email-device-ui');
  if (!ui) return;
  ui.innerHTML = \`<div class="source-log">Starting...</div>\`;

  const r = await fetch(BASE + '/api/sources/email/device-start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  }).then(r => r.json());

  if (r.error) { ui.innerHTML = \`<div style="color:#ef4444;font-size:0.8rem">\${r.error}</div>\`; return; }

  // Google: redirect-based OAuth (device flow blocks Gmail scopes)
  if (r.auth_url) {
    ui.innerHTML = \`<div class="source-log">Redirecting to Google…</div>\`;
    window.location.href = r.auth_url;
    return;
  }

  // Microsoft: device flow (show code + poll)
  ui.innerHTML = \`
    <div style="background:#0f1117;border-radius:8px;padding:14px 16px;margin-top:4px">
      <div style="font-size:0.8rem;color:#94a3b8;margin-bottom:10px">
        1. Open <a href="\${r.verification_url}" target="_blank" style="color:#6366f1">\${r.verification_url}</a>
      </div>
      <div style="font-size:0.8rem;color:#94a3b8;margin-bottom:10px">2. Sign in with Microsoft and enter this code:</div>
      <div style="font-size:1.5rem;font-weight:700;letter-spacing:4px;color:#f1f5f9;text-align:center;padding:8px 0">\${r.user_code}</div>
      <div class="source-log" id="email-device-status" style="margin-top:10px;text-align:center">Waiting for you to enter the code…</div>
    </div>\`;

  if (emailDevicePoller) clearInterval(emailDevicePoller);
  emailDevicePoller = setInterval(async () => {
    const s = await fetch(BASE + '/api/sources/email/device-poll?provider=' + provider).then(r => r.json());
    const status = document.getElementById('email-device-status');
    if (s.status === 'done') {
      clearInterval(emailDevicePoller); emailDevicePoller = null;
      await loadSources();
    } else if (s.status === 'expired') {
      clearInterval(emailDevicePoller); emailDevicePoller = null;
      if (ui) ui.innerHTML = \`<div style="color:#ef4444;font-size:0.8rem">Code expired. <button class="source-btn secondary" onclick="startEmailDevice('\${provider}')">Try again</button></div>\`;
    } else if (s.status === 'error') {
      clearInterval(emailDevicePoller); emailDevicePoller = null;
      if (ui) ui.innerHTML = \`<div style="color:#ef4444;font-size:0.8rem">\${s.message} <button class="source-btn secondary" onclick="startEmailDevice('\${provider}')">Try again</button></div>\`;
    } else if (status) {
      status.textContent = 'Waiting…';
    }
  }, 5000);
}

async function syncGoogleContacts() {
  const btn = document.getElementById('gc-sync-btn');
  const log = document.getElementById('gc-sync-log');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  if (log) log.textContent = '';

  const r = await fetch(BASE + '/api/sources/google-contacts/sync', { method: 'POST' }).then(r => r.json());

  if (r.needs_reauth) {
    if (log) log.textContent = 'Re-connect Gmail to grant contacts access.';
    if (btn) { btn.disabled = false; btn.textContent = 'Sync'; }
    startEmailDevice('google');
    return;
  }
  if (r.error) {
    if (log) log.textContent = '✗ ' + r.error;
    if (btn) { btn.disabled = false; btn.textContent = 'Sync'; }
    return;
  }
  if (log) log.textContent = \`✓ \${r.count} contacts synced\`;
  await loadSources();
}

async function startGoogleContactsOAuth() {
  const log = document.getElementById('log-googleContacts');
  if (log) log.textContent = 'Redirecting to Google…';
  const r = await fetch(BASE + '/api/sources/google-contacts/oauth-start', { method: 'POST' }).then(r => r.json());
  if (r.error) { if (log) log.textContent = '✗ ' + r.error; return; }
  window.location.href = r.auth_url;
}

function emailAutoHost(email) {
  const hostMap = { 'gmail.com': 'imap.gmail.com', 'googlemail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com', 'hotmail.com': 'outlook.office365.com',
    'live.com': 'outlook.office365.com', 'fastmail.com': 'imap.fastmail.com',
    'icloud.com': 'imap.mail.me.com', 'yahoo.com': 'imap.mail.yahoo.com' };
  const domain = email.split('@')[1]?.toLowerCase();
  const host = domain && hostMap[domain];
  const el = document.getElementById('email-host');
  if (host && el && !el.dataset.userEdited) el.value = host;
}

async function connectEmail() {
  const host = document.getElementById('email-host')?.value;
  const user = document.getElementById('email-user')?.value;
  const pass = document.getElementById('email-pass')?.value;
  const log = document.getElementById('email-log');
  if (!host || !user || !pass) { if (log) log.textContent = 'Fill in all fields'; return; }
  if (log) log.textContent = 'Connecting... (this may take a few minutes)';

  try {
    const r = await fetch(BASE + '/api/sources/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, user, pass }),
    });
    const d = await r.json();
    if (d.ok) { await loadSources(); }
    else if (log) log.textContent = '✗ ' + d.error;
  } catch (e) {
    if (log) log.textContent = '✗ ' + e.message;
  }
}

async function startWhatsapp() {
  const log = document.getElementById('wa-log');
  if (log) log.textContent = 'Starting WhatsApp session...';
  await fetch(BASE + '/api/sources/whatsapp/start', { method: 'POST' });
  renderSourceForm('whatsapp', { status: 'initializing' }, false);
  startWaPoller();
}

function startWaPoller() {
  if (waPoller) return;
  waPoller = setInterval(async () => {
    const s = await fetch(BASE + '/api/sources/whatsapp/status').then(r => r.json());
    const qrEl = document.getElementById('wa-qr-container');
    if (s.qr && qrEl) qrEl.innerHTML = \`<img src="\${s.qr}" alt="Scan with WhatsApp">
      <div style="font-size:0.75rem;color:#64748b;margin-top:6px">Scan with WhatsApp → Linked Devices → Link a Device</div>\`;
    if (s.progress) {
      const logEl = document.getElementById('wa-export-log');
      if (logEl) {
        logEl.textContent = s.progress.message;
        if (s.progress.step === 'messages' && s.progress.total) {
          const pct = Math.round((s.progress.current / s.progress.total) * 100);
          logEl.innerHTML = \`\${s.progress.message}<div style="margin-top:4px;height:4px;background:#1e2740;border-radius:2px"><div style="height:100%;width:\${pct}%;background:#22c55e;border-radius:2px;transition:width 0.3s"></div></div>\`;
        }
      }
    }
    if (s.status === 'ready' || s.status === 'authenticated') {
      const logEl = document.getElementById('wa-export-log');
      if (logEl && !s.progress) logEl.textContent = 'Connected, starting export...';
    }
    if (s.status === 'done' || s.status === 'connected') {
      clearInterval(waPoller); waPoller = null;
      await loadSources();
    }
    if (s.status === 'error' || s.status === 'auth_failure') {
      clearInterval(waPoller); waPoller = null;
      const card = document.getElementById('source-form-whatsapp');
      if (card) card.innerHTML = \`<div style="color:#ef4444">Connection failed. <button class="source-btn secondary" onclick="startWhatsapp()">Try again</button></div>\`;
    }
  }, 2000);
}

// Expose handler functions to window (required when browser extensions apply SES lockdown)
Object.assign(window, {
  showView, openContact, setSort, setViewMode, setSourceFilter, setHealthFilter,
  toggleUnnamed, toggleConvSearch, loadMore, jumpToLetter, onSearch,
  openPalette, closePalette, onCmdInput, onCmdKey,
  filterByCompany, onNetworkSearch,
  dzOver, dzLeave, dzDrop, uploadSource, reconnectSource,
  connectEmail, emailAutoHost, startWhatsapp,
  startEmailDevice, removeEmailAccount,
  copyName, copyIntro,
  loadGroupDetail, saveLidLabels,
  loadSettings, setMode, seedDemo,
  reviewDecide, reviewBack,
  saveScoreOverride, clearScoreOverride, toggleScoreOverride,
  openDraftPanel, copyDraft,
  runMerge,
  triggerSync,
  setActiveGoal, showGoalInput, hideGoalInput, onGoalInputKey, saveNewGoal, removeGoal,
  runAskQuery, setAskQuery,
});

init();
</script>
</body>
</html>`;
