/**
 * Manual match-review UI server.
 * Serves a web UI to approve/reject "possible" contact matches.
 *
 * Usage: node crm/review-server.js
 * Then open http://localhost:3456
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 3456;
const DATA = path.join(__dirname, '../data');
const OVERRIDES_PATH = path.join(DATA, 'unified/match_overrides.json');
const CONTACTS_PATH = path.join(DATA, 'unified/contacts.json');

// --- Data helpers ---

function loadOverrides() {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
}

function loadContacts() {
    const arr = JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf8'));
    const map = {};
    for (const c of arr) map[c.id] = c;
    return map;
}

function saveOverrides(overrides) {
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/pending') {
        const overrides = loadOverrides();
        const contacts = loadContacts();

        const pending = overrides
            .map((o, idx) => ({ ...o, _idx: idx }))
            .filter(o => o.confidence === 'possible');

        const enriched = pending.map(o => {
            const [idA, idB] = o.ids;
            return {
                _idx: o._idx,
                ids: o.ids,
                names: o.names,
                reason: o.reason,
                sources_linked: o.sources_linked,
                contactA: contacts[idA] || null,
                contactB: contacts[idB] || null,
            };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: enriched.length, items: enriched }));
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { idx, decision } = JSON.parse(body);
                // decision: 'confirmed' | 'likely' | 'skip'
                if (!['confirmed', 'likely', 'unsure', 'skip'].includes(decision)) {
                    res.writeHead(400); res.end('bad decision'); return;
                }
                const overrides = loadOverrides();
                if (idx < 0 || idx >= overrides.length) {
                    res.writeHead(400); res.end('bad idx'); return;
                }
                overrides[idx].confidence = decision;
                saveOverrides(overrides);

                const remaining = overrides.filter(o => o.confidence === 'possible').length;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, remaining }));
            } catch (e) {
                res.writeHead(500); res.end(e.message);
            }
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run-merge') {
        try {
            const out = execSync('node crm/merge.js', {
                cwd: path.join(__dirname, '..'),
                encoding: 'utf8',
                timeout: 30000,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, output: out }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, output: e.message }));
        }
        return;
    }

    res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
    console.log(`Review UI: http://localhost:${PORT}`);
    console.log('Press Ctrl+C to stop.');
});

// --- Inline HTML ---

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Contact Match Review</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0f1117; color: #e2e8f0; min-height: 100vh; }

  header { background: #1a1f2e; border-bottom: 1px solid #2d3748; padding: 14px 24px;
           display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 1.1rem; font-weight: 600; color: #a78bfa; }
  #progress-wrap { display: flex; align-items: center; gap: 12px; }
  #progress-bar { width: 200px; height: 6px; background: #2d3748; border-radius: 3px; overflow: hidden; }
  #progress-fill { height: 100%; background: #a78bfa; transition: width 0.3s; }
  #progress-text { font-size: 0.85rem; color: #94a3b8; }

  #merge-btn { padding: 7px 16px; background: #4f46e5; border: none; border-radius: 6px;
               color: #fff; font-size: 0.85rem; cursor: pointer; }
  #merge-btn:hover { background: #4338ca; }

  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }

  #empty { text-align: center; padding: 80px 0; color: #64748b; }
  #empty h2 { font-size: 1.5rem; margin-bottom: 8px; }

  .card { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 12px;
           overflow: hidden; margin-bottom: 24px; }

  .reason-bar { background: #12172a; border-bottom: 1px solid #2d3748;
                padding: 12px 20px; display: flex; align-items: center; gap: 10px; }
  .reason-bar .tag { background: #312e81; color: #c4b5fd; border-radius: 4px;
                      padding: 2px 8px; font-size: 0.75rem; font-weight: 600; }
  .reason-bar .reason-text { font-size: 0.85rem; color: #94a3b8; flex: 1; }

  .contacts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .contact-panel { padding: 20px; }
  .contact-panel:first-child { border-right: 1px solid #2d3748; }

  .source-badge { display: inline-block; font-size: 0.7rem; font-weight: 700;
                  letter-spacing: 0.05em; padding: 2px 8px; border-radius: 20px;
                  margin-bottom: 10px; text-transform: uppercase; }
  .badge-whatsapp { background: #064e3b; color: #34d399; }
  .badge-linkedin  { background: #1e3a5f; color: #60a5fa; }

  .contact-name { font-size: 1.15rem; font-weight: 700; color: #f1f5f9; margin-bottom: 12px; }

  .field { display: flex; gap: 8px; margin-bottom: 7px; font-size: 0.875rem; }
  .field-label { color: #64748b; min-width: 80px; flex-shrink: 0; }
  .field-value { color: #cbd5e1; word-break: break-all; }
  .field-value a { color: #60a5fa; text-decoration: none; }
  .field-value a:hover { text-decoration: underline; }

  .actions { display: flex; gap: 10px; padding: 16px 20px; border-top: 1px solid #2d3748;
             background: #12172a; }
  .actions button { flex: 1; padding: 10px; border: none; border-radius: 8px;
                    font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: opacity 0.1s; }
  .actions button:hover { opacity: 0.85; }
  .btn-confirm { background: #065f46; color: #6ee7b7; }
  .btn-likely  { background: #1e3a5f; color: #93c5fd; }
  .btn-unsure  { background: #2d2a1a; color: #fcd34d; }
  .btn-skip    { background: #3b1818; color: #fca5a5; }
  .btn-back    { background: #1e2433; color: #64748b; border: 1px solid #2d3748;
                 flex: 0 0 auto !important; padding: 10px 14px !important; }
  .btn-back:hover { color: #94a3b8 !important; opacity: 1 !important; }
  .btn-selected { outline: 2px solid rgba(255,255,255,0.5); filter: brightness(1.5); }

  .kbd { display: inline-block; background: #2d3748; border: 1px solid #4a5568;
         border-radius: 4px; padding: 1px 6px; font-size: 0.75rem; color: #94a3b8;
         font-family: monospace; margin-left: 4px; }

  #merge-output { background: #12172a; border: 1px solid #2d3748; border-radius: 8px;
                  padding: 16px; margin-top: 16px; font-family: monospace;
                  font-size: 0.8rem; color: #86efac; white-space: pre-wrap;
                  max-height: 200px; overflow-y: auto; display: none; }

  #loading { text-align: center; padding: 60px 0; color: #64748b; }
</style>
</head>
<body>

<header>
  <h1>Contact Match Review</h1>
  <div id="progress-wrap">
    <div id="progress-bar"><div id="progress-fill" style="width:0%"></div></div>
    <span id="progress-text">Loading…</span>
  </div>
  <button id="merge-btn" onclick="runMerge()">Run merge.js</button>
</header>

<main>
  <div id="loading">Loading matches…</div>
  <div id="empty" style="display:none">
    <h2>All done!</h2>
    <p>No more "possible" matches to review. Click <strong>Run merge.js</strong> to apply your decisions.</p>
    <div id="merge-output"></div>
  </div>
  <div id="card-container"></div>
</main>

<script>
let items = [];
let current = 0;
let total = 0;
const decisions = {}; // item._idx -> decision made this session

async function load() {
  const r = await fetch('/api/pending');
  const d = await r.json();
  items = d.items;
  total = d.total;
  document.getElementById('loading').style.display = 'none';
  renderProgress();
  renderCard();
}

function renderProgress() {
  const done = Object.keys(decisions).length;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-text').textContent =
    total === 0 ? 'All reviewed' : \`\${done} / \${total} reviewed\`;
}

function renderCard() {
  const container = document.getElementById('card-container');
  const empty = document.getElementById('empty');

  if (current >= items.length) {
    container.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  const item = items[current];
  const wa = item.contactA;
  const li = item.contactB;

  const waFields = wa ? [
    ['Name', wa.name || '—'],
    ['Phone', (wa.phones || []).join(', ') || '—'],
    ['About', wa.sources?.whatsapp?.about || '—'],
    ['Type', wa.sources?.whatsapp?.isBusiness ? 'Business' : 'Personal'],
  ] : [['ID', item.ids[0]], ['Status', 'Contact not found in unified']];

  const liFields = li ? [
    ['Name', li.name || '—'],
    ['Email', li.emails?.[0] || li.sources?.linkedin?.email || '—'],
    ['Company', li.sources?.linkedin?.company || '—'],
    ['Position', li.sources?.linkedin?.position || '—'],
    ['Connected', li.sources?.linkedin?.connectedOn || '—'],
    ['Profile', li.sources?.linkedin?.profileUrl
      ? \`<a href="\${escHtml(li.sources.linkedin.profileUrl)}" target="_blank">Open ↗</a>\`
      : '—'],
  ] : [['ID', item.ids[1]], ['Status', 'Contact not found in unified']];

  const fieldRow = (label, val) =>
    \`<div class="field"><span class="field-label">\${escHtml(label)}</span>
     <span class="field-value">\${typeof val === 'string' && val.startsWith('<') ? val : escHtml(String(val))}</span></div>\`;

  const prev = decisions[item._idx];
  const sel = d => prev === d ? 'btn-selected' : '';

  container.innerHTML = \`
    <div class="card">
      <div class="reason-bar">
        <span class="tag">\${prev ? escHtml(prev) : 'pending'}</span>
        <span class="reason-text">\${escHtml(item.reason)}</span>
      </div>
      <div class="contacts-row">
        <div class="contact-panel">
          <div class="source-badge badge-whatsapp">WhatsApp</div>
          <div class="contact-name">\${escHtml(item.names?.[0] || item.ids[0])}</div>
          \${waFields.map(([l, v]) => fieldRow(l, v)).join('')}
        </div>
        <div class="contact-panel">
          <div class="source-badge badge-linkedin">LinkedIn</div>
          <div class="contact-name">\${escHtml(item.names?.[1] || item.ids[1])}</div>
          \${liFields.map(([l, v]) => fieldRow(l, v)).join('')}
        </div>
      </div>
      <div class="actions">
        \${current > 0 ? '<button class="btn-back" onclick="goBack()">← Back <span class="kbd">←</span></button>' : ''}
        <button class="btn-confirm \${sel('confirmed')}" onclick="decide('confirmed')">
          ✓ Same person <span class="kbd">Y</span>
        </button>
        <button class="btn-likely \${sel('likely')}" onclick="decide('likely')">
          ~ Probably same <span class="kbd">L</span>
        </button>
        <button class="btn-unsure \${sel('unsure')}" onclick="decide('unsure')">
          ? Unsure <span class="kbd">U</span>
        </button>
        <button class="btn-skip \${sel('skip')}" onclick="decide('skip')">
          ✗ Different people <span class="kbd">N</span>
        </button>
      </div>
    </div>
  \`;
}

async function decide(decision) {
  const item = items[current];
  if (!item) return;

  await fetch('/api/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idx: item._idx, decision }),
  });

  decisions[item._idx] = decision;
  current++;
  renderProgress();
  renderCard();
}

function goBack() {
  if (current > 0) { current--; renderCard(); }
}


async function runMerge() {
  const btn = document.getElementById('merge-btn');
  btn.disabled = true;
  btn.textContent = 'Running…';
  const out = document.getElementById('merge-output');
  out.style.display = 'block';
  out.textContent = 'Running node crm/merge.js…';

  const r = await fetch('/api/run-merge', { method: 'POST' });
  const d = await r.json();
  out.textContent = d.output || d.error || '(no output)';
  btn.disabled = false;
  btn.textContent = 'Run merge.js';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'y' || e.key === 'Y') decide('confirmed');
  else if (e.key === 'n' || e.key === 'N') decide('skip');
  else if (e.key === 'l' || e.key === 'L') decide('likely');
  else if (e.key === 'u' || e.key === 'U') decide('unsure');
  else if (e.key === 'ArrowLeft') goBack();
});

load();
</script>
</body>
</html>`;
