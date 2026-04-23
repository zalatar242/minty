/**
 * crm/sync.js — Background sync daemon
 *
 * Manages continuous data freshness:
 *   - WhatsApp: real-time message listener (if session exists)
 *   - Gmail: incremental poll every 10 minutes via history API
 *   - Google Contacts: poll every 30 minutes via syncToken
 *   - LinkedIn/Telegram/SMS: fs.watchFile() on source directories
 *
 * Usage: const { startSyncDaemon } = require('./sync');
 *        const daemon = startSyncDaemon(uuid, userDataDir);
 *        // later: daemon.stop()
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const { fetchCalendarEvents, processMeetings } = require('./calendar');

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

function getDefaultSyncState() {
    return {
        whatsapp:      { lastSyncAt: null, status: 'idle', messageCount: 0 },
        email:         { lastSyncAt: null, historyId: null, status: 'idle' },
        googleContacts:{ lastSyncAt: null, syncToken: null, status: 'idle' },
        linkedin:      { lastSyncAt: null, fileHash: null, status: 'ok' },
        telegram:      { lastSyncAt: null, fileHash: null, status: 'ok' },
        sms:           { lastSyncAt: null, fileHash: null, status: 'ok' },
        calendar:      { lastSyncAt: null, status: 'idle', upcomingMeetings: [] },
    };
}

/**
 * Returns true if the lastSyncAt timestamp is older than maxAgeMs.
 * A null/missing lastSyncAt is always considered stale.
 */
function isStale(lastSyncAt, maxAgeMs) {
    if (!lastSyncAt) return true;
    const age = Date.now() - new Date(lastSyncAt).getTime();
    return age > maxAgeMs;
}

/**
 * Compute MD5 hash of a Buffer or string.
 */
function hashContent(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Compute a combined hash for all files in a directory.
 * Returns null if the directory does not exist.
 * Sorted so the result is stable regardless of readdir order.
 */
function computeDirHash(dirPath) {
    if (!fs.existsSync(dirPath)) return null;
    let files;
    try { files = fs.readdirSync(dirPath).sort(); } catch { return null; }
    const parts = files.map(f => {
        try { return hashContent(fs.readFileSync(path.join(dirPath, f))); }
        catch { return ''; }
    });
    return hashContent(parts.join('|'));
}

function loadSyncState(statePath) {
    try {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        // Merge with defaults so new sources are always present
        return deepMerge(getDefaultSyncState(), raw);
    } catch {
        return getDefaultSyncState();
    }
}

function saveSyncState(statePath, state) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    try { fs.chmodSync(statePath, 0o600); } catch { /* ignore */ }
}

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source || {})) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

function gmailGet(accessToken, endpoint) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname: 'gmail.googleapis.com',
            path: '/gmail/v1/users/me/' + endpoint,
            headers: { Authorization: 'Bearer ' + accessToken },
        }, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Bad JSON: ' + body.slice(0, 200))); }
            });
        }).on('error', reject);
    });
}

function googlePost(hostname, path, bodyStr) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname, path, method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(bodyStr),
            },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

/**
 * Refresh a Google OAuth access token using the stored refresh token.
 * Returns new tokens or throws on failure.
 */
async function refreshGoogleToken(refreshToken) {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set');
    }
    const result = await googlePost('oauth2.googleapis.com', '/token',
        new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }).toString()
    );
    if (result.error) throw new Error(result.error_description || result.error);
    return result;
}

// ---------------------------------------------------------------------------
// Importer / merge helpers
// ---------------------------------------------------------------------------

function runMerge(userDataDir, outDir) {
    execFileSync('node', ['crm/merge.js'], {
        cwd: ROOT,
        env: { ...process.env, CRM_DATA_DIR: userDataDir, CRM_OUT_DIR: outDir },
        encoding: 'utf8',
        timeout: 120000,
    });
}

function runImporter(script, env) {
    execFileSync('node', [script], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 120000,
    });
}

// ---------------------------------------------------------------------------
// Gmail incremental sync
// ---------------------------------------------------------------------------

/**
 * Run one incremental Gmail sync cycle for a single account.
 * - If no historyId stored: fetches the current historyId and stops (seeds state)
 * - If historyId stored: fetches new messages since that historyId, appends interactions,
 *   and updates historyId
 */
async function syncGmailAccount(account, emailDataDir, userDataDir) {
    const { accessToken, refreshToken, email } = account;
    let token = accessToken;

    // Helper: refresh token on 401
    async function getToken() {
        if (!refreshToken) throw new Error('No refresh token for ' + email);
        const fresh = await refreshGoogleToken(refreshToken);
        token = fresh.access_token;
        account.accessToken = token; // mutate so next call uses fresh token
        return token;
    }

    async function apiGet(endpoint) {
        let res = await gmailGet(token, endpoint);
        if (res.error?.code === 401) {
            await getToken();
            res = await gmailGet(token, endpoint);
        }
        if (res.error) throw new Error('Gmail API: ' + JSON.stringify(res.error));
        return res;
    }

    // Seed: get current historyId if we don't have one
    const stateFile = path.join(emailDataDir, 'gmail-state.json');
    let gmailState = {};
    try { gmailState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { gmailState = {}; }

    const accountState = gmailState[email] || {};

    if (!accountState.historyId) {
        // Seed the historyId — just get the profile (no messages fetched)
        const profile = await apiGet('profile');
        accountState.historyId = profile.historyId;
        gmailState[email] = accountState;
        fs.writeFileSync(stateFile, JSON.stringify(gmailState, null, 2));
        console.log(`[sync] Gmail ${email}: seeded historyId ${accountState.historyId}`);
        return { newMessages: 0 };
    }

    // Incremental: fetch history since last historyId
    let historyData;
    try {
        historyData = await apiGet(`history?startHistoryId=${accountState.historyId}&historyTypes=messageAdded`);
    } catch (e) {
        if (e.message.includes('404') || e.message.includes('historyId')) {
            // historyId expired — reseed
            const profile = await apiGet('profile');
            accountState.historyId = profile.historyId;
            gmailState[email] = accountState;
            fs.writeFileSync(stateFile, JSON.stringify(gmailState, null, 2));
            console.log(`[sync] Gmail ${email}: historyId expired, reseeded`);
            return { newMessages: 0 };
        }
        throw e;
    }

    const history = historyData.history || [];
    const newHistoryId = historyData.historyId || accountState.historyId;

    // Collect message IDs from history
    const msgIds = new Set();
    for (const h of history) {
        for (const added of (h.messagesAdded || [])) {
            if (added.message?.id) msgIds.add(added.message.id);
        }
    }

    if (msgIds.size === 0) {
        accountState.historyId = newHistoryId;
        gmailState[email] = accountState;
        fs.writeFileSync(stateFile, JSON.stringify(gmailState, null, 2));
        return { newMessages: 0 };
    }

    // Load existing messages.json
    const messagesPath = path.join(emailDataDir, 'messages.json');
    let messages = [];
    try { messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8')); } catch { messages = []; }
    const existingIds = new Set(messages.map(m => m.messageId));

    // Fetch metadata for new messages
    let added = 0;
    for (const id of msgIds) {
        if (existingIds.has(id)) continue;
        try {
            const msg = await apiGet(
                `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`
            );
            if (msg.error) continue;
            const headers = {};
            (msg.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });
            const date = headers.date ? new Date(headers.date).toISOString() : null;
            messages.push({
                messageId: id,
                timestamp: date,
                from: headers.from || null,
                to: headers.to || null,
                cc: headers.cc || null,
                subject: headers.subject || null,
            });
            added++;
        } catch (e) { /* skip bad messages */ }
    }

    if (added > 0) {
        fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2));
        // Re-run merge to incorporate new interactions
        try {
            const unifiedDir = path.join(userDataDir, 'unified');
            runMerge(userDataDir, unifiedDir);
        } catch (e) {
            console.error('[sync] Gmail merge error:', e.message);
        }
    }

    accountState.historyId = newHistoryId;
    gmailState[email] = accountState;
    fs.writeFileSync(stateFile, JSON.stringify(gmailState, null, 2));

    console.log(`[sync] Gmail ${email}: +${added} new messages`);
    return { newMessages: added };
}

// ---------------------------------------------------------------------------
// Google Contacts incremental sync
// ---------------------------------------------------------------------------

async function syncGoogleContacts(account, gcDataDir, userDataDir) {
    const stateFile = path.join(gcDataDir, 'gc-state.json');
    let gcState = {};
    try { gcState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { gcState = {}; }

    const { email, accessToken, refreshToken } = account;
    let token = accessToken;

    async function getToken() {
        if (!refreshToken) throw new Error('No refresh token for ' + email);
        const fresh = await refreshGoogleToken(refreshToken);
        token = fresh.access_token;
        account.accessToken = token;
        return token;
    }

    async function peopleGet(endpoint) {
        const res = await new Promise((resolve, reject) => {
            https.get({
                hostname: 'people.googleapis.com',
                path: '/v1/' + endpoint,
                headers: { Authorization: 'Bearer ' + token },
            }, res => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
            }).on('error', reject);
        });
        if (res.error?.code === 401) {
            await getToken();
            return peopleGet(endpoint);
        }
        if (res.error) throw new Error('People API: ' + JSON.stringify(res.error));
        return res;
    }

    const syncToken = gcState[email]?.syncToken;
    const fields = 'names,emailAddresses,phoneNumbers,organizations';

    let endpoint = `people/me/connections?personFields=${fields}&pageSize=1000&requestSyncToken=true`;
    if (syncToken) endpoint += `&syncToken=${encodeURIComponent(syncToken)}`;

    const res = await peopleGet(endpoint);
    const changed = res.connections || [];
    const newSyncToken = res.nextSyncToken;

    if (changed.length === 0) {
        if (newSyncToken) {
            gcState[email] = { ...(gcState[email] || {}), syncToken: newSyncToken };
            fs.writeFileSync(stateFile, JSON.stringify(gcState, null, 2));
        }
        return { changed: 0 };
    }

    // Write changed contacts to gcDataDir for the importer to process
    const contactsPath = path.join(gcDataDir, 'contacts.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(contactsPath, 'utf8')); } catch { existing = []; }

    // Build a map of existing contacts by email for dedup
    const emailIndex = {};
    existing.forEach((c, i) => {
        (c.emails || []).forEach(e => { emailIndex[e] = i; });
    });

    for (const p of changed) {
        if (p.metadata?.deleted) continue;
        const name = p.names?.[0]?.displayName || null;
        const phones = (p.phoneNumbers || []).map(ph => (ph.value || '').replace(/[^0-9+]/g, '')).filter(n => n.length >= 7);
        const emails = (p.emailAddresses || []).map(em => (em.value || '').toLowerCase().trim()).filter(e => e.includes('@'));
        const org = p.organizations?.[0]?.name || null;
        const title = p.organizations?.[0]?.title || null;
        if (!name && phones.length === 0 && emails.length === 0) continue;

        const newEntry = { name, phones, emails, org, title, source: 'google-contacts' };
        // Update existing if email matches, otherwise append
        const idx = emails.map(e => emailIndex[e]).find(i => i !== undefined);
        if (idx !== undefined) {
            existing[idx] = { ...existing[idx], ...newEntry };
        } else {
            existing.push(newEntry);
            emails.forEach(e => { emailIndex[e] = existing.length - 1; });
        }
    }

    fs.writeFileSync(contactsPath, JSON.stringify(existing, null, 2));

    // Re-run merge
    try {
        const unifiedDir = path.join(userDataDir, 'unified');
        runMerge(userDataDir, unifiedDir);
    } catch (e) {
        console.error('[sync] Google Contacts merge error:', e.message);
    }

    if (newSyncToken) {
        gcState[email] = { ...(gcState[email] || {}), syncToken: newSyncToken };
        fs.writeFileSync(stateFile, JSON.stringify(gcState, null, 2));
    }

    console.log(`[sync] Google Contacts ${email}: ${changed.length} changed contacts`);
    return { changed: changed.length };
}

// ---------------------------------------------------------------------------
// File-based source watcher
// ---------------------------------------------------------------------------

/**
 * Watch a source directory for changes and trigger import + merge on change.
 * Returns an unwatcher function.
 */
function watchSourceDir(source, sourceDir, importScript, importEnv, userDataDir, statePath) {
    if (!fs.existsSync(sourceDir)) return () => {};

    let currentHash = computeDirHash(sourceDir);

    // Update initial state
    const state = loadSyncState(statePath);
    if (!state[source]) state[source] = {};
    state[source].fileHash = currentHash;
    state[source].status = 'ok';
    saveSyncState(statePath, state);

    function check() {
        const newHash = computeDirHash(sourceDir);
        if (newHash && newHash !== currentHash) {
            currentHash = newHash;
            console.log(`[sync] ${source} file changed — triggering import`);
            const s = loadSyncState(statePath);
            if (!s[source]) s[source] = {};
            s[source].status = 'syncing';
            saveSyncState(statePath, s);
            try {
                runImporter(importScript, { ...importEnv, [importScript.includes('linkedin') ? 'LINKEDIN_OUT_DIR' : importScript.includes('telegram') ? 'TELEGRAM_OUT_DIR' : 'SMS_OUT_DIR']: sourceDir });
                const unifiedDir = path.join(userDataDir, 'unified');
                runMerge(userDataDir, unifiedDir);
                const s2 = loadSyncState(statePath);
                s2[source] = { fileHash: newHash, status: 'ok', lastSyncAt: new Date().toISOString() };
                saveSyncState(statePath, s2);
                console.log(`[sync] ${source}: import + merge complete`);
            } catch (e) {
                console.error(`[sync] ${source} import error:`, e.message);
                const s2 = loadSyncState(statePath);
                s2[source] = { ...(s2[source] || {}), status: 'error', lastErrorAt: new Date().toISOString() };
                saveSyncState(statePath, s2);
            }
        }
    }

    // Poll every 60 seconds (fs.watchFile is slow/unreliable in some environments)
    const interval = setInterval(check, 60 * 1000);
    return () => clearInterval(interval);
}

// ---------------------------------------------------------------------------
// WhatsApp live sync attachment
// ---------------------------------------------------------------------------

/**
 * Attach a live message listener to an authenticated whatsapp-web.js client.
 * Called by server.js after client becomes ready.
 * Appends new messages directly to the whatsapp chats.json and triggers merge.
 */
function attachWhatsAppSync(uuid, client, userDataDir, statePath) {
    const waDir = path.join(userDataDir, 'whatsapp');

    client.on('message', async msg => {
        try {
            const chatsPath = path.join(waDir, 'chats.json');
            let chats = [];
            try { chats = JSON.parse(fs.readFileSync(chatsPath, 'utf8')); } catch { chats = []; }

            const chatId = msg.from;
            let chat = chats.find(c => c.id === chatId);
            if (!chat) {
                chat = { id: chatId, messages: [] };
                chats.push(chat);
            }
            if (!chat.messages) chat.messages = [];
            chat.messages.push({
                id: msg.id?.id || crypto.randomBytes(8).toString('hex'),
                timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString(),
                from: msg.from,
                to: msg.to,
                body: msg.body || '',
                type: msg.type || 'chat',
            });

            fs.writeFileSync(chatsPath, JSON.stringify(chats, null, 2));

            // Update sync state
            const state = loadSyncState(statePath);
            state.whatsapp.messageCount = (state.whatsapp.messageCount || 0) + 1;
            state.whatsapp.lastSyncAt = new Date().toISOString();
            state.whatsapp.status = 'active';
            saveSyncState(statePath, state);

            // Incremental merge (async, don't block message handler)
            try {
                const unifiedDir = path.join(userDataDir, 'unified');
                runMerge(userDataDir, unifiedDir);
            } catch (e) {
                console.error('[sync] WhatsApp merge error:', e.message);
            }
        } catch (e) {
            console.error('[sync] WhatsApp message handler error:', e.message);
        }
    });

    // Mark WhatsApp as active in sync state
    const state = loadSyncState(statePath);
    state.whatsapp.status = 'active';
    state.whatsapp.lastSyncAt = new Date().toISOString();
    saveSyncState(statePath, state);

    console.log(`[sync] WhatsApp live sync attached for user ${uuid}`);
}

// ---------------------------------------------------------------------------
// Google Calendar sync
// ---------------------------------------------------------------------------

/**
 * Sync upcoming Google Calendar events for one Google account.
 * Fetches events for the next 7 days, cross-references attendees against
 * contacts.json, and writes enriched meeting list to sync-state.json.
 *
 * Gracefully handles 403 (calendar scope not granted) — marks status 'no_scope'.
 */
async function syncCalendarForAccount(account, userDataDir, statePath) {
    const { email, accessToken, refreshToken } = account;
    let token = accessToken;

    async function getToken() {
        if (!refreshToken) throw new Error('No refresh token for ' + email);
        const fresh = await refreshGoogleToken(refreshToken);
        token = fresh.access_token;
        account.accessToken = token;
        return token;
    }

    // Fetch events, retry once on 401
    let rawEvents;
    try {
        rawEvents = await fetchCalendarEvents(token);
    } catch (e) {
        if (e.status === 401) {
            await getToken();
            rawEvents = await fetchCalendarEvents(token);
        } else if (e.status === 403) {
            // Calendar scope not yet granted — mark accordingly, don't throw
            const s = loadSyncState(statePath);
            s.calendar = { ...(s.calendar || {}), status: 'no_scope', lastSyncAt: new Date().toISOString() };
            saveSyncState(statePath, s);
            console.log(`[sync] Calendar ${email}: scope not granted (re-auth needed)`);
            return { meetings: 0 };
        } else {
            throw e;
        }
    }

    // Load contacts + insights for cross-referencing
    const unifiedDir = path.join(userDataDir, 'unified');
    let contacts = [];
    let insights = {};
    try { contacts = JSON.parse(fs.readFileSync(path.join(unifiedDir, 'contacts.json'), 'utf8')); } catch { contacts = []; }
    try { insights = JSON.parse(fs.readFileSync(path.join(unifiedDir, 'insights.json'), 'utf8')); } catch { insights = {}; }

    const meetings = processMeetings(rawEvents, contacts, insights);

    const s = loadSyncState(statePath);
    s.calendar = {
        lastSyncAt:       new Date().toISOString(),
        status:           'ok',
        upcomingMeetings: meetings,
    };
    saveSyncState(statePath, s);

    console.log(`[sync] Calendar ${email}: ${meetings.length} upcoming meetings`);
    return { meetings: meetings.length };
}

// ---------------------------------------------------------------------------
// Main daemon
// ---------------------------------------------------------------------------

const EMAIL_POLL_MS       = 10 * 60 * 1000;  // 10 minutes
const GC_POLL_MS          = 30 * 60 * 1000;  // 30 minutes
const CALENDAR_POLL_MS    = 15 * 60 * 1000;  // 15 minutes
const STALE_FILE_WARN_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Start the background sync daemon for one user.
 *
 * @param {string} uuid         - User UUID
 * @param {string} userDataDir  - Absolute path to data/users/:uuid (or equivalent)
 * @returns {{ stop, getState, attachWhatsApp }}
 */
function startSyncDaemon(uuid, userDataDir) {
    const statePath = path.join(userDataDir, 'sync-state.json');
    const cleanups = [];

    // Initialize state file if missing
    if (!fs.existsSync(statePath)) {
        saveSyncState(statePath, getDefaultSyncState());
    }

    // ── File-based source watchers ────────────────────────────────────────

    const fileSources = [
        { source: 'linkedin',  dir: path.join(userDataDir, 'linkedin'),       script: 'sources/linkedin/import.js',  envKey: 'LINKEDIN_OUT_DIR' },
        { source: 'telegram',  dir: path.join(userDataDir, 'telegram'),       script: 'sources/telegram/import.js',  envKey: 'TELEGRAM_OUT_DIR' },
        { source: 'sms',       dir: path.join(userDataDir, 'sms'),            script: 'sources/sms/import.js',       envKey: 'SMS_OUT_DIR' },
    ];

    for (const { source, dir, script, envKey } of fileSources) {
        const stop = watchSourceDir(source, dir, script, { [envKey]: dir }, userDataDir, statePath);
        cleanups.push(stop);

        // Check if this source is stale (> 30 days since last file change)
        const state = loadSyncState(statePath);
        const src = state[source] || {};
        if (src.lastSyncAt && isStale(src.lastSyncAt, STALE_FILE_WARN_MS)) {
            src.status = 'stale';
            state[source] = src;
            saveSyncState(statePath, state);
        }
    }

    // ── Gmail polling ─────────────────────────────────────────────────────

    async function pollEmail() {
        const usersPath = path.join(__dirname, '../data/users.json');
        let users;
        try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')); }
        catch { return; }

        const user = users[uuid];
        const accounts = user?.sources?.email?.accounts || [];
        const googleAccounts = accounts.filter(a => a.provider === 'google' && a.refreshToken);

        if (googleAccounts.length === 0) return;

        const emailDataDir = path.join(userDataDir, 'email');
        fs.mkdirSync(emailDataDir, { recursive: true });

        const state = loadSyncState(statePath);
        state.email.status = 'syncing';
        saveSyncState(statePath, state);

        let totalNew = 0;
        for (const account of googleAccounts) {
            try {
                const result = await syncGmailAccount(account, emailDataDir, userDataDir);
                totalNew += result.newMessages;
                // Persist refreshed token back to users.json
                const u2 = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
                const accts = u2[uuid]?.sources?.email?.accounts || [];
                const idx = accts.findIndex(a => a.email === account.email);
                if (idx !== -1) accts[idx].accessToken = account.accessToken;
                if (u2[uuid]?.sources?.email?.accounts) {
                    u2[uuid].sources.email.accounts = accts;
                    fs.writeFileSync(usersPath, JSON.stringify(u2, null, 2));
                    try { fs.chmodSync(usersPath, 0o600); } catch { /* ignore */ }
                }
            } catch (e) {
                console.error(`[sync] Gmail poll error for ${account.email}:`, e.message);
            }
        }

        const s2 = loadSyncState(statePath);
        s2.email.lastSyncAt = new Date().toISOString();
        s2.email.status = 'idle';
        saveSyncState(statePath, s2);

        if (totalNew > 0) console.log(`[sync] Email: +${totalNew} new messages across all accounts`);
    }

    const emailInterval = setInterval(() => {
        pollEmail().catch(e => console.error('[sync] Email poll error:', e.message));
    }, EMAIL_POLL_MS);
    cleanups.push(() => clearInterval(emailInterval));

    // Kick off initial email poll after 30s to avoid startup contention
    const emailInitial = setTimeout(() => {
        pollEmail().catch(e => console.error('[sync] Email initial poll error:', e.message));
    }, 30 * 1000);
    cleanups.push(() => clearTimeout(emailInitial));

    // ── Google Contacts polling ───────────────────────────────────────────

    async function pollGoogleContacts() {
        const usersPath = path.join(__dirname, '../data/users.json');
        let users;
        try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')); }
        catch { return; }

        const user = users[uuid];
        const accounts = user?.sources?.email?.accounts || [];
        const gcAccounts = accounts.filter(a => a.provider === 'google' && a.refreshToken);

        if (gcAccounts.length === 0) return;

        const gcDataDir = path.join(userDataDir, 'google-contacts');
        fs.mkdirSync(gcDataDir, { recursive: true });

        const state = loadSyncState(statePath);
        state.googleContacts.status = 'syncing';
        saveSyncState(statePath, state);

        for (const account of gcAccounts) {
            try {
                await syncGoogleContacts(account, gcDataDir, userDataDir);
                // Persist refreshed token
                const u2 = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
                const accts = u2[uuid]?.sources?.email?.accounts || [];
                const idx = accts.findIndex(a => a.email === account.email);
                if (idx !== -1 && account.accessToken) accts[idx].accessToken = account.accessToken;
                if (u2[uuid]?.sources?.email?.accounts) {
                    u2[uuid].sources.email.accounts = accts;
                    fs.writeFileSync(usersPath, JSON.stringify(u2, null, 2));
                    try { fs.chmodSync(usersPath, 0o600); } catch { /* ignore */ }
                }
            } catch (e) {
                console.error(`[sync] Google Contacts poll error for ${account.email}:`, e.message);
            }
        }

        const s2 = loadSyncState(statePath);
        s2.googleContacts.lastSyncAt = new Date().toISOString();
        s2.googleContacts.status = 'idle';
        saveSyncState(statePath, s2);
    }

    const gcInterval = setInterval(() => {
        pollGoogleContacts().catch(e => console.error('[sync] GC poll error:', e.message));
    }, GC_POLL_MS);
    cleanups.push(() => clearInterval(gcInterval));

    // Initial GC poll after 60s
    const gcInitial = setTimeout(() => {
        pollGoogleContacts().catch(e => console.error('[sync] GC initial poll error:', e.message));
    }, 60 * 1000);
    cleanups.push(() => clearTimeout(gcInitial));

    // ── Google Calendar polling ───────────────────────────────────────────

    async function pollCalendar() {
        const usersPath = path.join(__dirname, '../data/users.json');
        let users;
        try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')); }
        catch { return; }

        const user = users[uuid];
        const accounts = user?.sources?.email?.accounts || [];
        const googleAccounts = accounts.filter(a => a.provider === 'google' && a.refreshToken);

        if (googleAccounts.length === 0) return;

        const state = loadSyncState(statePath);
        state.calendar = { ...(state.calendar || getDefaultSyncState().calendar), status: 'syncing' };
        saveSyncState(statePath, state);

        // Use the first connected Google account for calendar (primary calendar)
        const account = googleAccounts[0];
        try {
            await syncCalendarForAccount(account, userDataDir, statePath);
            // Persist refreshed token
            const u2 = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
            const accts = u2[uuid]?.sources?.email?.accounts || [];
            const idx = accts.findIndex(a => a.email === account.email);
            if (idx !== -1 && account.accessToken) accts[idx].accessToken = account.accessToken;
            if (u2[uuid]?.sources?.email?.accounts) {
                u2[uuid].sources.email.accounts = accts;
                fs.writeFileSync(usersPath, JSON.stringify(u2, null, 2));
                try { fs.chmodSync(usersPath, 0o600); } catch { /* ignore */ }
            }
        } catch (e) {
            console.error(`[sync] Calendar poll error for ${account.email}:`, e.message);
            const s2 = loadSyncState(statePath);
            s2.calendar = { ...(s2.calendar || {}), status: 'error', lastErrorAt: new Date().toISOString() };
            saveSyncState(statePath, s2);
        }
    }

    const calendarInterval = setInterval(() => {
        pollCalendar().catch(e => console.error('[sync] Calendar poll error:', e.message));
    }, CALENDAR_POLL_MS);
    cleanups.push(() => clearInterval(calendarInterval));

    // Initial calendar poll after 45s (stagger with email and GC)
    const calendarInitial = setTimeout(() => {
        pollCalendar().catch(e => console.error('[sync] Calendar initial poll error:', e.message));
    }, 45 * 1000);
    cleanups.push(() => clearTimeout(calendarInitial));

    console.log(`[sync] Daemon started for user ${uuid}`);

    return {
        stop() {
            cleanups.forEach(fn => fn());
            console.log(`[sync] Daemon stopped for user ${uuid}`);
        },
        getState() {
            return loadSyncState(statePath);
        },
        /** Call this after a whatsapp-web.js client becomes ready */
        attachWhatsApp(client) {
            attachWhatsAppSync(uuid, client, userDataDir, statePath);
        },
    };
}

// ---------------------------------------------------------------------------
// Manual trigger (for POST /api/sync/trigger/:source)
// ---------------------------------------------------------------------------

/**
 * Manually trigger sync for a specific source.
 * Returns a promise that resolves to { ok, message }.
 */
async function triggerSync(uuid, source, userDataDir) {
    const statePath = path.join(userDataDir, 'sync-state.json');
    const state = loadSyncState(statePath);
    const usersPath = path.join(__dirname, '../data/users.json');

    switch (source) {
        case 'email': {
            let users;
            try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch { return { ok: false, message: 'No users.json' }; }
            const accounts = (users[uuid]?.sources?.email?.accounts || []).filter(a => a.provider === 'google' && a.refreshToken);
            if (accounts.length === 0) return { ok: false, message: 'No Google email accounts connected' };

            const emailDataDir = path.join(userDataDir, 'email');
            fs.mkdirSync(emailDataDir, { recursive: true });
            let total = 0;
            for (const account of accounts) {
                const result = await syncGmailAccount(account, emailDataDir, path.join(userDataDir, 'unified'), userDataDir);
                total += result.newMessages;
            }
            state.email.lastSyncAt = new Date().toISOString();
            state.email.status = 'idle';
            saveSyncState(statePath, state);
            return { ok: true, message: `+${total} new emails` };
        }

        case 'googleContacts': {
            let users;
            try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch { return { ok: false, message: 'No users.json' }; }
            const accounts = (users[uuid]?.sources?.email?.accounts || []).filter(a => a.provider === 'google' && a.refreshToken);
            if (accounts.length === 0) return { ok: false, message: 'No Google accounts connected' };

            const gcDataDir = path.join(userDataDir, 'google-contacts');
            fs.mkdirSync(gcDataDir, { recursive: true });
            for (const account of accounts) {
                await syncGoogleContacts(account, gcDataDir, userDataDir);
            }
            state.googleContacts.lastSyncAt = new Date().toISOString();
            state.googleContacts.status = 'idle';
            saveSyncState(statePath, state);
            return { ok: true, message: 'Google Contacts synced' };
        }

        case 'linkedin':
        case 'telegram':
        case 'sms': {
            const folderMap = { linkedin: 'linkedin', telegram: 'telegram', sms: 'sms' };
            const scriptMap = { linkedin: 'sources/linkedin/import.js', telegram: 'sources/telegram/import.js', sms: 'sources/sms/import.js' };
            const envKeyMap = { linkedin: 'LINKEDIN_OUT_DIR', telegram: 'TELEGRAM_OUT_DIR', sms: 'SMS_OUT_DIR' };
            const sourceDir = path.join(userDataDir, folderMap[source]);
            if (!fs.existsSync(sourceDir)) return { ok: false, message: `No ${source} data directory` };
            const newHash = computeDirHash(sourceDir);
            try {
                runImporter(scriptMap[source], { [envKeyMap[source]]: sourceDir });
                const unifiedDir = path.join(userDataDir, 'unified');
                runMerge(userDataDir, unifiedDir);
                const s2 = loadSyncState(statePath);
                s2[source] = { fileHash: newHash, status: 'ok', lastSyncAt: new Date().toISOString() };
                saveSyncState(statePath, s2);
                return { ok: true, message: `${source} import + merge complete` };
            } catch (e) {
                return { ok: false, message: e.message };
            }
        }

        case 'calendar': {
            let users;
            try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch { return { ok: false, message: 'No users.json' }; }
            const accounts = (users[uuid]?.sources?.email?.accounts || []).filter(a => a.provider === 'google' && a.refreshToken);
            if (accounts.length === 0) return { ok: false, message: 'No Google account connected' };
            try {
                const result = await syncCalendarForAccount(accounts[0], userDataDir, statePath);
                return { ok: true, message: `${result.meetings} upcoming meetings synced` };
            } catch (e) {
                return { ok: false, message: e.message };
            }
        }

        case 'whatsapp':
            return { ok: false, message: 'WhatsApp sync is event-driven — reconnect from Sources view' };

        default:
            return { ok: false, message: `Unknown source: ${source}` };
    }
}

module.exports = {
    startSyncDaemon,
    triggerSync,
    syncCalendarForAccount,
    // Pure functions — exported for testing
    getDefaultSyncState,
    isStale,
    hashContent,
    computeDirHash,
    loadSyncState,
    saveSyncState,
    deepMerge,
};
