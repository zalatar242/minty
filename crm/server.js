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
        try {
            fs.writeFileSync(p, contents, { flag: 'wx' });
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
        }
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
    let fd;
    try {
        // Open + fstat + read on the same FD so the mtime always matches the
        // bytes we read (avoids TOCTOU between statSync and readFileSync if
        // the file is replaced mid-call).
        fd = fs.openSync(key, 'r');
        const mtime = fs.fstatSync(fd).mtimeMs;
        let raw;
        if (_contactsCache[key] && _contactsCache[key].mtime === mtime) {
            raw = _contactsCache[key].raw;
        } else {
            raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
            _contactsCache[key] = { mtime, raw };
        }
        return paths.selfIds?.size ? raw.filter(c => !paths.selfIds.has(c.id)) : raw;
    } catch {
        return [];
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* already closed */ }
        }
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
        if (!list.length) return null;
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
        linkedinState: readLinkedInState(),
        linkedinExportRequest: (() => {
            try { return JSON.parse(fs.readFileSync(path.join(DATA, 'linkedin', '.export-request.json'), 'utf8')); }
            catch { return null; }
        })(),
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
// Transient export-failure retry counter, kept across re-inits so a failing
// chat can't trigger an infinite reconnect loop. Reset on a successful export.
const waRetryCounts = {};
const WA_MAX_RETRIES = 2;
const WA_RETRY_DELAY_MS = 10 * 1000;

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

    // Self-heal stale Chromium SingletonLock/Cookie/Socket symlinks left
    // behind by a Puppeteer that crashed without cleanup. Without this, the
    // next client.initialize() hangs in "initializing" forever waiting for
    // a lock no live process holds.
    try {
        const sessionDir = path.join(authDir, `session-${uuid}`);
        if (fs.existsSync(sessionDir)) {
            for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
                const p = path.join(sessionDir, name);
                try {
                    const stat = fs.lstatSync(p);
                    if (!stat.isSymbolicLink()) continue;
                    const target = fs.readlinkSync(p);
                    const m = target.match(/-(\d+)$/);
                    let alive = false;
                    if (m) {
                        try { process.kill(Number(m[1]), 0); alive = true; }
                        catch { alive = false; }
                    }
                    if (!alive) {
                        fs.unlinkSync(p);
                        console.log(`[whatsapp] cleared stale ${name} for ${uuid}`);
                    }
                } catch { /* ignore — file gone or unreadable */ }
            }
        }
    } catch (e) {
        console.error('[whatsapp] singleton-lock cleanup failed:', e.message);
    }

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
            waRetryCounts[uuid] = 0;
            notifications.dismiss(dataDir, 'whatsapp');
            ensureSyncDaemon(uuid).attachWhatsApp(client);
        } catch (e) {
            console.error('WhatsApp export error:', e);
            waClients[uuid].status = 'error';
            // Detached Frame / Target closed / Session closed are Puppeteer
            // transient errors that fire mid-export when the WhatsApp Web tab
            // recycles. The export saves chats.json per chat, so a fresh
            // client.initialize() on the same LocalAuth session resumes from
            // where it stopped. Retry up to WA_MAX_RETRIES then bail to a
            // banner.
            const isTransient = /detached Frame|Target closed|Session closed|Protocol error|Execution context|Page crashed/i.test(e.message || '');
            const retryCount = (waRetryCounts[uuid] || 0);
            if (isTransient && retryCount < WA_MAX_RETRIES) {
                waRetryCounts[uuid] = retryCount + 1;
                console.log(`[whatsapp] transient export error — retry ${retryCount + 1}/${WA_MAX_RETRIES} in ${WA_RETRY_DELAY_MS / 1000}s`);
                notifications.set(dataDir, 'whatsapp', {
                    message: `WhatsApp export hit a transient error (Chromium frame detached). Retrying ${retryCount + 1}/${WA_MAX_RETRIES} in ${WA_RETRY_DELAY_MS / 1000}s…`,
                    pauseSync: false,
                });
                try { await client.destroy(); } catch { /* swallow */ }
                delete waClients[uuid];
                waSilentResume.delete(uuid);
                setTimeout(() => {
                    try { autoResumeWhatsapp(uuid); }
                    catch (err) { console.error('[whatsapp] retry init failed:', err.message); }
                }, WA_RETRY_DELAY_MS);
                return;
            }
            // Non-transient (or out of retries) — surface to the UI.
            const msg = (e.message || 'unknown').slice(0, 240);
            notifications.set(dataDir, 'whatsapp', {
                message: `WhatsApp export failed: ${msg}. Open Sources → WhatsApp → Reconnect to retry.`,
                pauseSync: false,
            });
            waRetryCounts[uuid] = 0;
            waSilentResume.delete(uuid);
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
    // 500/chat default. Earlier 10k/Infinity caps got the user temporarily
    // banned for "TOS violation" — WhatsApp's spam detection treats reading
    // many thousands of messages from many thousands of chats as
    // exfiltration-like activity. 500 covers virtually every meaningful
    // conversation thread and stays well within human-like reading volume.
    // Power users can opt in to deeper backfill via WHATSAPP_MSG_LIMIT=N.
    const limit = opts.limit ?? (Number(process.env.WHATSAPP_MSG_LIMIT) || 500);
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

        // Smart-skip: if chat.lastMessage.timestamp <= the most-recent
        // message we already have on disk for this chat, there's nothing
        // new to fetch. Skipping entirely (no fetchMessages call at all)
        // is the main lever that keeps incremental syncs from looking
        // like spam to WhatsApp's detection. Net effect on a 27k-contact
        // account: ~50 fetches per resume instead of ~27,000.
        let skipFetch = false;
        const newLastMs = chat.lastMessage?.timestamp ? chat.lastMessage.timestamp * 1000 : null;
        const existingMessages = result[name]?.messages;
        if (newLastMs && Array.isArray(existingMessages) && existingMessages.length > 0) {
            const newest = existingMessages.reduce((max, m) => {
                const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
                return t > max ? t : max;
            }, 0);
            if (newest > 0 && newLastMs <= newest) skipFetch = true;
        }

        // Per-chat jitter — slows the export to human-like pacing. Skip
        // the wait when we're skipping the fetch too (no LinkedIn-side
        // work happens, no need to back off the loop).
        if (i > 0 && !skipFetch) {
            const jitterMs = 800 + Math.floor(Math.random() * 700);
            await new Promise((r) => setTimeout(r, jitterMs));
        }

        // Attempt message fetch; tolerate failure (known wweb.js waitForChatLoading issue).
        let newMessages = [];
        if (!skipFetch) {
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
    // When auto-sync is enabled for LinkedIn, "Sync now" should trigger a
    // headless-browser scrape (fetch.js), not the ZIP importer. The default
    // triggerSync() path runs import.js with a default EXPORT_DIR that has
    // no CSVs, which is technically a no-op now but isn't what the user
    // intends when they click the button.
    if (source === 'linkedin' && userConfig.isLinkedInAutosyncEnabled(DATA)) {
        const daemon = ensureSyncDaemon(uuid);
        if (typeof daemon?.triggerLinkedInSync === 'function') {
            daemon.triggerLinkedInSync();
            return json(res, { ok: true, message: 'LinkedIn auto-sync started — progress will appear in the toast.' });
        }
        return json(res, { ok: false, message: 'Auto-sync daemon not ready — try reloading the page.' }, 503);
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
        const { buildEmailIndex, enrichAttendees, sortMeetings } = require('./calendar');
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
        json(res, { error: 'playwright-missing', message: 'Playwright is not installed. Run npm install in the project directory once.' }, 503); return;
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

function handleLinkedInRequestExport(req, res) {
    if (!linkedInGate(req, res)) return;
    if (!linkedInPlaywrightAvailable()) {
        json(res, { error: 'playwright-missing', message: 'Playwright is not installed. Run npm install in the project directory once.' }, 503); return;
    }
    const reqPath = path.join(DATA, 'linkedin', '.export-request.json');
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(reqPath, 'utf8')); } catch { /* none */ }
    if (existing && existing.status === 'pending' && existing.requestedAt) {
        const ageMs = Date.now() - new Date(existing.requestedAt).getTime();
        if (!Number.isNaN(ageMs) && ageMs < 7 * 24 * 60 * 60 * 1000) {
            return json(res, { ok: false, error: 'already-pending', requestedAt: existing.requestedAt }, 409);
        }
    }
    const { spawn } = require('child_process');
    const scriptPath = path.resolve(__dirname, '../sources/linkedin/request-export.js');
    const child = spawn(process.execPath, [scriptPath], {
        detached: false, stdio: 'ignore', env: { ...process.env, CRM_DATA_DIR: DATA },
    });
    child.unref();
    _linkedinChildren.set(child.pid, child);
    child.on('exit', () => _linkedinChildren.delete(child.pid));
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: child.pid, message: 'A Chromium window is opening so you can confirm. After you submit, LinkedIn will email you when the archive is ready (typically 24-72h).' }));
}

function handleLinkedInGetExportRequest(req, res, params, paths, uuid) {
    const reqPath = path.join(DATA, 'linkedin', '.export-request.json');
    try {
        const raw = fs.readFileSync(reqPath, 'utf8');
        json(res, { request: JSON.parse(raw) });
    } catch {
        json(res, { request: null });
    }
}

function handleLinkedInCheckExport(req, res, params, paths, uuid) {
    if (!linkedInGate(req, res)) return;
    if (!linkedInPlaywrightAvailable()) {
        json(res, { error: 'playwright-missing' }, 503); return;
    }
    try {
        const daemon = ensureSyncDaemon(uuid);
        if (typeof daemon?.triggerExportCheck === 'function') {
            daemon.triggerExportCheck();
            json(res, { ok: true, message: 'Checking with LinkedIn — progress will appear in the terminal log.' });
        } else {
            json(res, { error: 'daemon-not-ready' }, 503);
        }
    } catch (e) {
        json(res, { error: e.message }, 500);
    }
}

function handleLinkedInSync(req, res) {
    if (!linkedInGate(req, res)) return;
    if (!linkedInPlaywrightAvailable()) {
        json(res, { error: 'playwright-missing', message: 'Playwright is not installed. Run npm install in the project directory once.' }, 503); return;
    }
    const state = readLinkedInState();
    if (state.status === 'syncing') { json(res, { error: 'sync in progress' }, 409); return; }
    if (state.status === 'disconnected') {
        json(res, { error: 'not connected', message: 'Click Connect to LinkedIn in Settings first.' }, 400); return;
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
    ['POST', /^\/api\/linkedin\/request-export$/,         handleLinkedInRequestExport],
    ['GET',  /^\/api\/linkedin\/export-request$/,         handleLinkedInGetExportRequest],
    ['POST', /^\/api\/linkedin\/check-export$/,           handleLinkedInCheckExport],
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

    // Auto-resume WhatsApp on boot — opt-in only. The earlier always-on
    // behaviour combined with deep message-history backfill triggered
    // WhatsApp's spam detection and got the maintainer temporarily banned.
    // Now: gated on userConfig.whatsappAutoResume (default false). Users
    // who want it can flip the toggle in Settings; default users get
    // explicit-click behaviour from Sources → WhatsApp.
    if (userConfig.getConfig(DATA).whatsappAutoResume === true) {
        setTimeout(() => {
            try { autoResumeWhatsapp(SINGLE_USER_UUID); }
            catch (e) { console.error('[autosync] WhatsApp boot resume failed:', e.message); }
        }, 5 * 1000);
    } else {
        console.log('[autosync] WhatsApp boot resume disabled (set whatsappAutoResume=true in Settings to enable)');
    }
});

// ---------------------------------------------------------------------------
// HTML / CSS / JS (single-page app)
// ---------------------------------------------------------------------------

const HTML = require('./ui.html');
