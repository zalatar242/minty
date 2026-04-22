/**
 * Personal CRM hub server.
 * Serves a full web UI: contact list, contact detail, match review queue.
 *
 * Usage: node crm/server.js   (or: npm run crm)
 * Then open http://localhost:3456
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3456;
const DATA = path.join(__dirname, '../data');
const CONTACTS_PATH  = path.join(DATA, 'unified/contacts.json');
const INTERACTIONS_PATH = path.join(DATA, 'unified/interactions.json');
const OVERRIDES_PATH = path.join(DATA, 'unified/match_overrides.json');

// Bootstrap empty data files on first run so the server doesn't crash
// when nothing has been imported yet.
(function ensureDataFiles() {
    const dir = path.join(DATA, 'unified');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CONTACTS_PATH)) fs.writeFileSync(CONTACTS_PATH, '[]');
    if (!fs.existsSync(INTERACTIONS_PATH)) fs.writeFileSync(INTERACTIONS_PATH, '[]');
})();

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadContacts() {
    return JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf8'));
}

function loadOverrides() {
    if (!fs.existsSync(OVERRIDES_PATH)) return [];
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
}

function saveOverrides(overrides) {
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

// Lightweight summary for list view
function contactSummary(c) {
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
    };
}

// ---------------------------------------------------------------------------
// Interaction index (built once on first request)
// ---------------------------------------------------------------------------

let _interactionIndex = null;

function getInteractionIndex() {
    if (_interactionIndex) return _interactionIndex;

    const interactions = JSON.parse(fs.readFileSync(INTERACTIONS_PATH, 'utf8'));
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

    _interactionIndex = idx;
    console.log(`Interaction index built (${interactions.length} interactions)`);
    return idx;
}

function getContactInteractions(contact) {
    const idx = getInteractionIndex();
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

function body(req) {
    return new Promise((resolve, reject) => {
        let s = '';
        req.on('data', c => s += c);
        req.on('end', () => { try { resolve(JSON.parse(s)); } catch(e) { reject(e); } });
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
        // ---- Serve app ----
        if (req.method === 'GET' && p === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(HTML); return;
        }

        // ---- Contacts list ----
        if (req.method === 'GET' && p === '/api/contacts') {
            const contacts = loadContacts();
            json(res, contacts.map(contactSummary)); return;
        }

        // ---- Contact detail ----
        if (req.method === 'GET' && p.startsWith('/api/contacts/') && !p.endsWith('/interactions') && !p.endsWith('/notes')) {
            const id = decodeURIComponent(p.slice('/api/contacts/'.length));
            const contacts = loadContacts();
            const contact = contacts.find(c => c.id === id);
            if (!contact) { json(res, { error: 'not found' }, 404); return; }
            json(res, contact); return;
        }

        // ---- Contact interactions ----
        if (req.method === 'GET' && p.endsWith('/interactions')) {
            const id = decodeURIComponent(p.slice('/api/contacts/'.length, -'/interactions'.length));
            const contacts = loadContacts();
            const contact = contacts.find(c => c.id === id);
            if (!contact) { json(res, { error: 'not found' }, 404); return; }
            const interactions = getContactInteractions(contact);
            json(res, interactions); return;
        }

        // ---- Save notes ----
        if (req.method === 'POST' && p.endsWith('/notes')) {
            const id = decodeURIComponent(p.slice('/api/contacts/'.length, -'/notes'.length));
            const { notes } = await body(req);
            const contacts = loadContacts();
            const contact = contacts.find(c => c.id === id);
            if (!contact) { json(res, { error: 'not found' }, 404); return; }
            contact.notes = notes;
            contact.updatedAt = new Date().toISOString();
            fs.writeFileSync(CONTACTS_PATH, JSON.stringify(contacts, null, 2));
            json(res, { ok: true }); return;
        }

        // ---- Review: pending matches ----
        if (req.method === 'GET' && p === '/api/pending') {
            const overrides = loadOverrides();
            const contacts = loadContacts();
            const byId = {};
            for (const c of contacts) byId[c.id] = c;

            const pending = overrides
                .map((o, idx) => ({ ...o, _idx: idx }))
                .filter(o => o.confidence === 'possible');

            const enriched = pending.map(o => ({
                _idx: o._idx,
                ids: o.ids,
                names: o.names,
                reason: o.reason,
                contactA: byId[o.ids[0]] || null,
                contactB: byId[o.ids[1]] || null,
            }));

            json(res, { total: enriched.length, items: enriched }); return;
        }

        // ---- Review: decide ----
        if (req.method === 'POST' && p === '/api/decide') {
            const { idx, decision } = await body(req);
            if (!['confirmed', 'likely', 'unsure', 'skip'].includes(decision)) {
                json(res, { error: 'bad decision' }, 400); return;
            }
            const overrides = loadOverrides();
            if (idx < 0 || idx >= overrides.length) {
                json(res, { error: 'bad idx' }, 400); return;
            }
            overrides[idx].confidence = decision;
            saveOverrides(overrides);
            json(res, { ok: true, remaining: overrides.filter(o => o.confidence === 'possible').length });
            return;
        }

        // ---- Run merge ----
        if (req.method === 'POST' && p === '/api/run-merge') {
            // Invalidate interaction index so it rebuilds after merge
            _interactionIndex = null;
            const out = execSync('node crm/merge.js', {
                cwd: path.join(__dirname, '..'),
                encoding: 'utf8',
                timeout: 30000,
            });
            json(res, { ok: true, output: out }); return;
        }

        res.writeHead(404); res.end('not found');
    } catch (e) {
        console.error(e);
        res.writeHead(500); res.end(e.message);
    }
});

server.listen(PORT, () => {
    console.log(`CRM hub: http://localhost:${PORT}`);
    console.log('Press Ctrl+C to stop.');
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
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #0f1117; color: #e2e8f0; height: 100vh; display: flex; overflow: hidden; }

/* ---- Sidebar ---- */
nav { width: 220px; background: #12172a; border-right: 1px solid #1e2740;
      display: flex; flex-direction: column; flex-shrink: 0; }
.nav-logo { padding: 20px 18px 16px; font-size: 1rem; font-weight: 700; color: #a78bfa;
            letter-spacing: -0.02em; border-bottom: 1px solid #1e2740; }
.nav-logo span { color: #64748b; font-weight: 400; }
.nav-links { padding: 10px 8px; flex: 1; }
.nav-link { display: flex; align-items: center; gap: 10px; padding: 9px 10px;
            border-radius: 7px; cursor: pointer; color: #64748b; font-size: 0.875rem;
            font-weight: 500; transition: all 0.1s; border: none; background: none;
            width: 100%; text-align: left; }
.nav-link:hover { background: #1a2035; color: #94a3b8; }
.nav-link.active { background: #1e2740; color: #e2e8f0; }
.nav-link .icon { font-size: 1rem; width: 20px; text-align: center; }
.nav-badge { margin-left: auto; background: #4f46e5; color: #fff; border-radius: 10px;
             padding: 1px 7px; font-size: 0.7rem; font-weight: 700; }

/* ---- Main ---- */
#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* ---- Contact list view ---- */
#view-contacts { display: flex; flex-direction: column; height: 100%; }
.list-header { padding: 16px 20px; border-bottom: 1px solid #1e2740; display: flex;
               flex-direction: column; gap: 10px; flex-shrink: 0; }
.list-header h2 { font-size: 1rem; font-weight: 600; color: #94a3b8; }
.search-wrap { position: relative; }
.search-wrap input { width: 100%; background: #1a1f2e; border: 1px solid #2d3748;
                     border-radius: 8px; padding: 9px 12px 9px 36px; color: #e2e8f0;
                     font-size: 0.875rem; outline: none; }
.search-wrap input:focus { border-color: #4f46e5; }
.search-wrap input::placeholder { color: #4a5568; }
.search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
               color: #4a5568; font-size: 0.9rem; pointer-events: none; }
.source-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.sf { padding: 4px 10px; border-radius: 20px; border: 1px solid #2d3748; background: none;
      color: #64748b; font-size: 0.75rem; font-weight: 600; cursor: pointer;
      transition: all 0.1s; }
.sf:hover { border-color: #4a5568; color: #94a3b8; }
.sf.active { background: #1e2740; border-color: #4f46e5; color: #a78bfa; }
.list-count { font-size: 0.75rem; color: #4a5568; }

.contact-list { flex: 1; overflow-y: auto; }
.contact-item { display: flex; align-items: center; gap: 14px; padding: 12px 20px;
                border-bottom: 1px solid #0f1117; cursor: pointer; transition: background 0.1s; }
.contact-item:hover { background: #12172a; }
.avatar { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center;
          justify-content: center; font-size: 0.875rem; font-weight: 700; flex-shrink: 0;
          letter-spacing: -0.02em; }
.contact-info { flex: 1; min-width: 0; }
.contact-name { font-size: 0.9rem; font-weight: 600; color: #e2e8f0;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.contact-meta { font-size: 0.78rem; color: #64748b; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.contact-meta .sep { margin: 0 4px; }
.source-dots { display: flex; gap: 4px; flex-shrink: 0; }
.dot { width: 7px; height: 7px; border-radius: 50%; }
.dot-whatsapp { background: #34d399; }
.dot-linkedin  { background: #60a5fa; }
.dot-googleContacts { background: #f97316; }
.dot-sms { background: #c084fc; }
.dot-telegram { background: #38bdf8; }
.dot-email { background: #facc15; }

.empty-state { text-align: center; padding: 60px 20px; color: #4a5568; }
.load-more { text-align: center; padding: 12px; }
.load-more button { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 7px;
                    padding: 7px 20px; color: #64748b; font-size: 0.8rem; cursor: pointer; }
.load-more button:hover { color: #94a3b8; }

/* ---- Contact detail view ---- */
#view-contact { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.detail-header { padding: 14px 20px; border-bottom: 1px solid #1e2740; display: flex;
                 align-items: center; gap: 14px; flex-shrink: 0; }
.back-btn { background: none; border: none; color: #64748b; cursor: pointer; font-size: 1.1rem;
            padding: 4px 8px; border-radius: 5px; }
.back-btn:hover { color: #94a3b8; background: #1a1f2e; }
.detail-hero { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; }
.detail-avatar { width: 48px; height: 48px; border-radius: 50%; display: flex;
                 align-items: center; justify-content: center; font-size: 1.1rem;
                 font-weight: 700; flex-shrink: 0; }
.detail-name { font-size: 1.1rem; font-weight: 700; color: #f1f5f9;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-sub { font-size: 0.8rem; color: #64748b; margin-top: 2px; }
.source-badges { display: flex; gap: 5px; flex-wrap: wrap; margin-left: auto; flex-shrink: 0; }
.badge { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.05em;
         padding: 3px 8px; border-radius: 20px; text-transform: uppercase; }
.badge-whatsapp { background: #064e3b; color: #34d399; }
.badge-linkedin  { background: #1e3a5f; color: #60a5fa; }
.badge-googleContacts { background: #431407; color: #fb923c; }
.badge-sms { background: #3b0764; color: #c084fc; }
.badge-telegram { background: #0c4a6e; color: #38bdf8; }
.badge-email { background: #422006; color: #facc15; }
.badge-apollo { background: #1c1917; color: #a8a29e; }

.detail-body { flex: 1; overflow-y: auto; padding: 20px; display: grid;
               grid-template-columns: 1fr 320px; gap: 20px; align-content: start; }
@media (max-width: 900px) { .detail-body { grid-template-columns: 1fr; } }

.detail-section { background: #1a1f2e; border: 1px solid #1e2740; border-radius: 10px;
                  padding: 16px; margin-bottom: 16px; }
.detail-section h3 { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
                     color: #4a5568; text-transform: uppercase; margin-bottom: 12px; }
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
.panel-badge { display: inline-block; margin-bottom: 8px; }
.panel-name { font-size: 1.05rem; font-weight: 700; color: #f1f5f9; margin-bottom: 10px; }
.field { display: flex; gap: 8px; margin-bottom: 6px; font-size: 0.82rem; }
.field-label { color: #64748b; min-width: 75px; flex-shrink: 0; }
.field-value { color: #cbd5e1; word-break: break-all; }
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

/* ---- Shared ---- */
.loading { text-align: center; padding: 60px 20px; color: #4a5568; }
</style>
</head>
<body>

<nav>
  <div class="nav-logo">CRM <span>hub</span></div>
  <div class="nav-links">
    <button class="nav-link active" id="nav-contacts" onclick="showView('contacts')">
      <span class="icon">👥</span> Contacts
    </button>
    <button class="nav-link" id="nav-review" onclick="showView('review')">
      <span class="icon">🔍</span> Review
      <span class="nav-badge" id="review-badge" style="display:none"></span>
    </button>
  </div>
</nav>

<div id="main">

  <!-- Contact list -->
  <div id="view-contacts">
    <div class="list-header">
      <div class="search-wrap">
        <span class="search-icon">🔎</span>
        <input type="text" id="search-input" placeholder="Search by name, company, phone…" oninput="onSearch(this.value)">
      </div>
      <div class="source-filters" id="source-filters">
        <button class="sf active" onclick="setSourceFilter('all', this)">All</button>
        <button class="sf" onclick="setSourceFilter('whatsapp', this)">WhatsApp</button>
        <button class="sf" onclick="setSourceFilter('linkedin', this)">LinkedIn</button>
        <button class="sf" onclick="setSourceFilter('googleContacts', this)">Google</button>
        <button class="sf" onclick="setSourceFilter('sms', this)">SMS</button>
        <button class="sf" onclick="setSourceFilter('multi', this)">Multi-source</button>
      </div>
      <div class="list-count" id="list-count"></div>
    </div>
    <div class="contact-list" id="contact-list">
      <div class="loading">Loading contacts…</div>
    </div>
  </div>

  <!-- Contact detail -->
  <div id="view-contact" style="display:none"></div>

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
// ============================================================
// State
// ============================================================
const PAGE_SIZE = 60;
let allContacts = [];
let filteredContacts = [];
let listPage = 0;
let searchQuery = '';
let sourceFilter = 'all';
let showUnnamed = false;
let searchTimer = null;

// Review state
let reviewItems = [];
let reviewCurrent = 0;
let reviewDecisions = {};

// ============================================================
// Startup
// ============================================================
async function init() {
  const [contactsRes] = await Promise.all([
    fetch('/api/contacts'),
  ]);
  allContacts = await contactsRes.json();
  applyFilter();
  loadReviewCount();
}

// ============================================================
// Navigation
// ============================================================
function showView(view) {
  document.getElementById('view-contacts').style.display = view === 'contacts' ? 'flex' : 'none';
  document.getElementById('view-contact').style.display  = view === 'contact'  ? 'flex' : 'none';
  document.getElementById('view-review').style.display   = view === 'review'   ? 'flex' : 'none';
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));
  const navId = view === 'contact' ? 'nav-contacts' : \`nav-\${view}\`;
  document.getElementById(navId)?.classList.add('active');
  if (view === 'review') loadReview();
}

// ============================================================
// Contact list
// ============================================================
function applyFilter() {
  const q = searchQuery.toLowerCase();
  filteredContacts = allContacts.filter(c => {
    if (sourceFilter !== 'all' && sourceFilter !== 'multi') {
      if (!c.sources.includes(sourceFilter)) return false;
    }
    if (sourceFilter === 'multi' && c.sources.length < 2) return false;
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
  listPage = 0;
  renderList();
}

function onSearch(val) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { searchQuery = val; applyFilter(); }, 150);
}

function setSourceFilter(f, btn) {
  sourceFilter = f;
  document.querySelectorAll('.sf').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  applyFilter();
}

function renderList() {
  const el = document.getElementById('contact-list');
  const shown = filteredContacts.slice(0, (listPage + 1) * PAGE_SIZE);

  const unnamedCount = allContacts.filter(c => !c.name).length;
  const namedCount = allContacts.length - unnamedCount;
  const visibleBase = showUnnamed ? allContacts.length : namedCount;
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

  if (filteredContacts.length === 0) {
    el.innerHTML = '<div class="empty-state">No contacts found</div>';
    return;
  }

  const rows = shown.map(c => {
    const initials = getInitials(c.name);
    const color = avatarColor(c.id);
    const meta = [c.company, c.position, c.location].filter(Boolean).join(' · ');
    const dots = c.sources.map(s => \`<div class="dot dot-\${s}" title="\${s}"></div>\`).join('');
    return \`<div class="contact-item" onclick="openContact('\${esc(c.id)}')">
      <div class="avatar" style="background:\${color.bg};color:\${color.fg}">\${esc(initials)}</div>
      <div class="contact-info">
        <div class="contact-name">\${esc(c.name || '(no name)')}</div>
        \${meta ? \`<div class="contact-meta">\${esc(meta)}</div>\` : ''}
      </div>
      <div class="source-dots">\${dots}</div>
    </div>\`;
  }).join('');

  const hasMore = filteredContacts.length > shown.length;
  el.innerHTML = rows + (hasMore
    ? \`<div class="load-more"><button onclick="loadMore()">Load more (\${filteredContacts.length - shown.length} remaining)</button></div>\`
    : '');
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

  const contact = await fetch(\`/api/contacts/\${encodeURIComponent(id)}\`).then(r => r.json());
  renderContactDetail(contact);
}

function renderContactDetail(c) {
  const el = document.getElementById('view-contact');
  const initials = getInitials(c.name);
  const color = avatarColor(c.id);

  const activeSources = Object.keys(c.sources).filter(k => c.sources[k]);
  const badges = activeSources.map(s =>
    \`<span class="badge badge-\${s}">\${sourceLabel(s)}</span>\`).join('');
  const apolloBadge = c.apollo ? '<span class="badge badge-apollo">Apollo</span>' : '';

  const company = c.sources.linkedin?.company || c.sources.googleContacts?.org || '';
  const position = c.sources.linkedin?.position || c.sources.googleContacts?.title || '';
  const sub = [company, position].filter(Boolean).join(' · ');

  // Build info rows
  const infoRows = [];
  if (c.phones?.length)  infoRows.push(['Phone', c.phones.join(', ')]);
  if (c.emails?.length)  infoRows.push(['Email', c.emails.join(', ')]);
  if (c.apollo?.location) infoRows.push(['Location', c.apollo.location]);
  if (company)           infoRows.push(['Company', company]);
  if (position)          infoRows.push(['Role', position]);
  if (c.sources.linkedin?.connectedOn) infoRows.push(['Connected', c.sources.linkedin.connectedOn]);
  if (c.sources.linkedin?.profileUrl)  infoRows.push(['LinkedIn', \`<a href="\${esc(c.sources.linkedin.profileUrl)}" target="_blank">Open ↗</a>\`]);
  if (c.apollo?.twitterUrl) infoRows.push(['Twitter', \`<a href="\${esc(c.apollo.twitterUrl)}" target="_blank">Open ↗</a>\`]);
  if (c.apollo?.headline)   infoRows.push(['Headline', c.apollo.headline]);

  const infoHtml = infoRows.map(([l, v]) =>
    \`<div class="info-label">\${esc(l)}</div><div class="info-value">\${v.startsWith('<') ? v : esc(v)}</div>\`
  ).join('');

  // Employment history from Apollo
  let apolloHtml = '';
  if (c.apollo?.employmentHistory?.length) {
    const jobs = c.apollo.employmentHistory.map(e => {
      const period = [e.startDate, e.endDate || (e.current ? 'present' : '')].filter(Boolean).join('–');
      return \`<div style="margin-bottom:8px;font-size:0.82rem">
        <div style="color:#cbd5e1;font-weight:600">\${esc(e.title || '')} <span style="color:#64748b">@ \${esc(e.company || '')}</span></div>
        <div style="color:#4a5568;font-size:0.75rem">\${esc(period)}</div>
      </div>\`;
    }).join('');
    apolloHtml = \`<div class="detail-section"><h3>Employment History</h3>\${jobs}</div>\`;
  }

  el.innerHTML = \`
    <div class="detail-header">
      <button class="back-btn" onclick="showView('contacts')">←</button>
      <div class="detail-hero">
        <div class="detail-avatar" style="background:\${color.bg};color:\${color.fg}">\${esc(initials)}</div>
        <div>
          <div class="detail-name">\${esc(c.name || '(no name)')}</div>
          \${sub ? \`<div class="detail-sub">\${esc(sub)}</div>\` : ''}
        </div>
      </div>
      <div class="source-badges">\${badges}\${apolloBadge}</div>
    </div>
    <div class="detail-body">
      <div>
        <div class="detail-section">
          <h3>Info</h3>
          <div class="info-grid">
            \${infoHtml || '<div class="info-value empty" style="grid-column:span 2">No info available</div>'}
          </div>
        </div>
        \${apolloHtml}
        <div class="detail-section" id="interactions-section">
          <h3>Interactions <span style="color:#4a5568;font-weight:400;font-size:0.65rem">— loading…</span></h3>
          <div id="interactions-body" style="color:#4a5568;font-size:0.82rem">Loading…</div>
        </div>
      </div>
      <div>
        <div class="detail-section">
          <h3>Notes</h3>
          <textarea class="notes-area" id="notes-area" placeholder="Add notes about this person…">\${esc(c.notes || '')}</textarea>
          <div class="notes-saved" id="notes-saved"></div>
        </div>
      </div>
    </div>
  \`;

  // Wire up notes save
  let notesTimer = null;
  document.getElementById('notes-area').addEventListener('input', e => {
    clearTimeout(notesTimer);
    document.getElementById('notes-saved').textContent = '';
    notesTimer = setTimeout(async () => {
      await fetch(\`/api/contacts/\${encodeURIComponent(c.id)}/notes\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: e.target.value }),
      });
      const saved = document.getElementById('notes-saved');
      if (saved) { saved.textContent = 'Saved'; setTimeout(() => { if(saved) saved.textContent=''; }, 2000); }
    }, 800);
  });

  // Load interactions async
  loadInteractions(c.id);
}

async function loadInteractions(contactId) {
  const interactions = await fetch(\`/api/contacts/\${encodeURIComponent(contactId)}/interactions\`).then(r => r.json());
  const el = document.getElementById('interactions-body');
  const header = document.querySelector('#interactions-section h3');
  if (!el) return;

  if (header) header.innerHTML = \`Interactions <span style="color:#4a5568;font-weight:400;font-size:0.65rem">— \${interactions.length} found</span>\`;

  if (interactions.length === 0) {
    el.innerHTML = '<div style="color:#374151;font-style:italic">No interactions found</div>';
    return;
  }

  const sourceColors = { whatsapp:'#34d399', linkedin:'#60a5fa', email:'#facc15', sms:'#c084fc', telegram:'#38bdf8' };
  const rows = interactions.slice(0, 50).map(i => {
    const color = sourceColors[i.source] || '#94a3b8';
    const ts = i.timestamp ? new Date(i.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '—';
    const body = (i.body || i.subject || '').slice(0, 120);
    return \`<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #0f1117;font-size:0.8rem">
      <div style="color:\${color};width:60px;flex-shrink:0;font-size:0.7rem;font-weight:600;padding-top:2px">\${i.source}</div>
      <div style="flex:1;min-width:0">
        <div style="color:#94a3b8;margin-bottom:2px">\${esc(ts)} · \${esc(i.chatName || '')}</div>
        <div style="color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${esc(body)}</div>
      </div>
    </div>\`;
  }).join('');

  const more = interactions.length > 50 ? \`<div style="color:#4a5568;font-size:0.75rem;padding-top:8px">+ \${interactions.length - 50} more</div>\` : '';
  el.innerHTML = rows + more;
}

// ============================================================
// Review queue
// ============================================================
async function loadReview() {
  const d = await fetch('/api/pending').then(r => r.json());
  reviewItems = d.items;
  renderReview();
}

async function loadReviewCount() {
  const d = await fetch('/api/pending').then(r => r.json());
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
  const wa = item.contactA, li = item.contactB;
  const prev = reviewDecisions[item._idx];
  const sel = d => prev === d ? 'btn-selected' : '';
  const tagClass = prev ? \`tag-\${prev}\` : '';

  const waFields = wa ? [
    ['Name', wa.name || '—'],
    ['Phone', (wa.phones||[]).join(', ') || '—'],
    ['About', wa.sources?.whatsapp?.about || '—'],
  ] : [['ID', item.ids[0]]];

  const liFields = li ? [
    ['Name', li.name || '—'],
    ['Email', li.emails?.[0] || li.sources?.linkedin?.email || '—'],
    ['Company', li.sources?.linkedin?.company || '—'],
    ['Role', li.sources?.linkedin?.position || '—'],
    ['Profile', li.sources?.linkedin?.profileUrl ? \`<a href="\${esc(li.sources.linkedin.profileUrl)}" target="_blank">Open ↗</a>\` : '—'],
  ] : [['ID', item.ids[1]]];

  const fieldRow = (l, v) => \`<div class="field"><span class="field-label">\${esc(l)}</span>
    <span class="field-value">\${v.startsWith('<') ? v : esc(String(v))}</span></div>\`;

  body.innerHTML = \`
    <div class="card">
      <div class="reason-bar">
        <span class="tag \${tagClass}">\${prev || 'pending'}</span>
        <span class="reason-text">\${esc(item.reason)}</span>
      </div>
      <div class="contacts-row">
        <div class="contact-panel">
          <span class="badge badge-whatsapp panel-badge">WhatsApp</span>
          <div class="panel-name">\${esc(item.names?.[0] || item.ids[0])}</div>
          \${waFields.map(([l,v]) => fieldRow(l,v)).join('')}
        </div>
        <div class="contact-panel">
          <span class="badge badge-linkedin panel-badge">LinkedIn</span>
          <div class="panel-name">\${esc(item.names?.[1] || item.ids[1])}</div>
          \${liFields.map(([l,v]) => fieldRow(l,v)).join('')}
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
  await fetch('/api/decide', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ idx: item._idx, decision }) });
  reviewDecisions[item._idx] = decision;
  reviewCurrent++;
  renderReview();
  loadReviewCount();
}

function reviewBack() { if (reviewCurrent > 0) { reviewCurrent--; renderReview(); } }

async function runMerge() {
  const out = document.getElementById('merge-output');
  if (out) { out.style.display = 'block'; out.textContent = 'Running…'; }
  const d = await fetch('/api/run-merge', { method:'POST' }).then(r => r.json());
  if (out) out.textContent = d.output || d.error || '(no output)';
  // Refresh contact data
  allContacts = await fetch('/api/contacts').then(r => r.json());
  applyFilter();
  loadReviewCount();
}

// ============================================================
// Keyboard shortcuts (review)
// ============================================================
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (document.getElementById('view-review').style.display !== 'none') {
    if (e.key === 'y' || e.key === 'Y') reviewDecide('confirmed');
    else if (e.key === 'n' || e.key === 'N') reviewDecide('skip');
    else if (e.key === 'l' || e.key === 'L') reviewDecide('likely');
    else if (e.key === 'u' || e.key === 'U') reviewDecide('unsure');
    else if (e.key === 'ArrowLeft') reviewBack();
  }
  if (e.key === 'Escape') showView('contacts');
});

// ============================================================
// Helpers
// ============================================================
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

init();
</script>
</body>
</html>`;
