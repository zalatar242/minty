'use strict';

// sources/linkedin/fetch.js — headless LinkedIn scraper.
//
// See plan: "Architecture Sketch", "Data flow", "CSV Column Contract",
// "Pagination, rate limits, and atomicity", and Eng addendum H1/H7/M3/M6.
//
// CSVs land in data/linkedin/.scraped-staging/ (NOT data/linkedin/export/ —
// crm/sync.js watches export/ for user-dropped ZIPs only; staging sibling
// avoids re-trigger loop per Eng H1). After writing, import.js is invoked
// explicitly with LINKEDIN_EXPORT_DIR=STAGING_DIR.
//
// Exit codes (DX-6): 0 ok / 1 unexpected / 2 pw-missing / 3 session
//                    expired-or-challenge / 4 locked-or-ENOSPC / 5 row-floor

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { acquireLock } = require('./lock');
const { classifyUrl } = require('./session-detect');
const { toCsvFile } = require('./csv');
const SELECTORS = require('./selectors');
const { CONNECTIONS_HEADER, connectionRowsToCsvMatrix } = require('./parse-connections');
const { MESSAGES_HEADER, messageRowsToCsvMatrix } = require('./parse-messages');

const ROOT = path.resolve(__dirname, '../../');
const LINKEDIN_DIR = path.join(ROOT, 'data', 'linkedin');
const PROFILE_DIR = process.env.LINKEDIN_PROFILE_DIR || path.join(LINKEDIN_DIR, 'browser-profile');
const STAGING_DIR = path.join(LINKEDIN_DIR, '.scraped-staging');
const LOCK_PATH = path.join(LINKEDIN_DIR, '.scrape.lock');
const STATE_PATH = path.join(ROOT, 'data', 'sync-state.json');

const THROTTLE_MS = Number(process.env.LINKEDIN_THROTTLE_MS) || 2000;
// Message-thread cap. Default: unlimited (scrape every thread). Set a positive
// integer via LINKEDIN_SYNC_MESSAGE_CAP to limit for speed. Unlimited on an
// account with N threads takes roughly N × (THROTTLE_MS × 6 + 1s) seconds —
// a 870-thread inbox at default throttle is ~3 hours. The scrape prints an
// estimate before starting.
const _msgCapRaw = process.env.LINKEDIN_SYNC_MESSAGE_CAP;
const MESSAGE_CAP = (!_msgCapRaw || _msgCapRaw === '0' || _msgCapRaw === 'all')
    ? Infinity
    : Number(_msgCapRaw);
const MAX_CONNECTIONS = Number(process.env.LINKEDIN_MAX_CONNECTIONS) || 30000;
const SKIP_DETAILS = process.env.LINKEDIN_SKIP_DETAILS === '1';
// Scrape pending invitations (sent + received). Off by default because pending
// invitations change often and rewriting Invitations.csv on every sync would
// clobber ZIP-imported historical invitations. Turn on explicitly to track
// pending. See README for the historical-vs-pending tradeoff.
const SCRAPE_INVITATIONS = process.env.LINKEDIN_SCRAPE_INVITATIONS === '1';

// --- sync-state.json -------------------------------------------------------

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) { return {}; }
}
function writeStatePatch(patch) {
    const cur = readState();
    const next = Object.assign({}, cur);
    next.linkedin = Object.assign({}, cur.linkedin || {}, patch);
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
    } catch (_) { /* best-effort */ }
}
function setProgress(phase, current, total) {
    writeStatePatch({ progress: { phase, current, total } });
}

// --- Atomic CSV write (Eng H7 — ENOSPC-safe) -------------------------------

function writeCsvAtomic(dir, filename, csvString) {
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, filename);
    const tmpPath = finalPath + '.tmp';
    let fd = null;
    try {
        fd = fs.openSync(tmpPath, 'w');
        fs.writeSync(fd, csvString);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, finalPath);
    } catch (err) {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
    }
}

// --- Row-count floor (Eng M3) ---------------------------------------------

function countCsvRows(filepath) {
    try {
        const s = fs.readFileSync(filepath, 'utf8');
        if (!s.trim()) return 0;
        const lines = s.split(/\r?\n/).filter((l) => l.length > 0);
        return Math.max(0, lines.length - 1);
    } catch (_) { return 0; }
}
function enforceRowFloor(filename, scrapedCount) {
    const prior = countCsvRows(path.join(STAGING_DIR, filename));
    const tooFewAbs = scrapedCount === 0 && prior > 10;
    const tooFewRel = prior > 0 && scrapedCount < 0.3 * prior;
    if (tooFewAbs || tooFewRel) {
        const err = new Error(`row-count-floor tripped for ${filename}: scraped=${scrapedCount}, prior=${prior}`);
        err.code = 'ROW_FLOOR'; err.scraped = scrapedCount; err.prior = prior;
        throw err;
    }
}

// --- Playwright lazy-require ----------------------------------------------

function loadPlaywright() {
    try { return require('playwright'); }
    catch (_) {
        const e = new Error('Playwright not installed. Run: npm run linkedin:setup');
        e.code = 'PLAYWRIGHT_MISSING';
        throw e;
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sessionError(cls) {
    const e = new Error(`LinkedIn session ${cls}`);
    e.code = 'SESSION'; e.cls = cls;
    return e;
}
function assertOk(page) {
    const cls = classifyUrl(page.url());
    if (cls !== 'ok') throw sessionError(cls);
}

// --- Scrape: connections list ---------------------------------------------

async function scrapeConnectionsList(page) {
    await page.goto(SELECTORS.CONNECTIONS_LIST.url, { waitUntil: 'domcontentloaded' });
    assertOk(page);

    let prevHeight = 0, stableTicks = 0;
    for (let i = 0; i < MAX_CONNECTIONS && stableTicks < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(THROTTLE_MS);
        const h = await page.evaluate(() => document.body.scrollHeight);
        if (h === prevHeight) stableTicks++; else { stableTicks = 0; prevHeight = h; }
        if (i % 5 === 0) setProgress('connections', i, -1);
    }

    const records = await page.evaluate((sels) => {
        const pickText = (root, ss) => {
            for (const s of ss) { const el = root.querySelector(s); if (el) return (el.textContent || '').trim(); }
            return '';
        };
        const pickHref = (root, ss) => {
            for (const s of ss) { const el = root.querySelector(s); if (el && el.getAttribute('href')) return el.getAttribute('href'); }
            return '';
        };
        let cards = [];
        for (const s of sels.card) {
            const found = Array.from(document.querySelectorAll(s));
            if (found.length) { cards = found; break; }
        }
        return cards.map((c) => ({
            fullName: pickText(c, sels.fullName),
            profileUrl: pickHref(c, sels.profileAnchor),
            occupation: pickText(c, sels.occupation),
        }));
    }, SELECTORS.CONNECTIONS_LIST);

    setProgress('connections', records.length, records.length);
    return records;
}

// --- Scrape: per-contact detail (Eng M6 — reuse single page) --------------

async function scrapeContactDetails(page, connections) {
    if (SKIP_DETAILS) return connections;
    const out = [];
    for (let i = 0; i < connections.length; i++) {
        const c = connections[i];
        const slugMatch = c.profileUrl && /\/in\/([^/?#]+)/.exec(c.profileUrl);
        if (!slugMatch) { out.push(c); continue; }
        const overlayUrl = SELECTORS.CONTACT_INFO_MODAL.urlTemplate.replace('{slug}', slugMatch[1]);
        let email = '', connectedOn = '';
        try {
            await page.goto(overlayUrl, { waitUntil: 'domcontentloaded' });
            assertOk(page);
            ({ email, connectedOn } = await page.evaluate((sels) => {
                const pickAttr = (ss, attr) => {
                    for (const s of ss) { const el = document.querySelector(s); if (el && el.getAttribute(attr)) return el.getAttribute(attr); }
                    return '';
                };
                const pickText = (ss) => {
                    for (const s of ss) { const el = document.querySelector(s); if (el) return (el.textContent || '').trim(); }
                    return '';
                };
                const mailto = pickAttr(sels.email, 'href');
                return {
                    email: mailto ? mailto.replace(/^mailto:/i, '').trim() : pickText(sels.email),
                    connectedOn: pickText(sels.connectedOn).replace(/^connected\s+/i, '').trim(),
                };
            }, SELECTORS.CONTACT_INFO_MODAL));
        } catch (err) {
            if (err && err.code === 'SESSION') throw err;
            // Individual overlay failures are non-fatal.
        }
        out.push(Object.assign({}, c, { email, connectedOn }));
        if (i % 10 === 0) setProgress('details', i, connections.length);
        await sleep(THROTTLE_MS);
    }
    setProgress('details', connections.length, connections.length);
    return out;
}

// --- Scrape: messaging -----------------------------------------------------

async function scrapeMessages(page) {
    await page.goto(SELECTORS.MESSAGING_INBOX.url, { waitUntil: 'domcontentloaded' });
    assertOk(page);
    await page.waitForTimeout(THROTTLE_MS);

    const threads = await page.evaluate((sels) => {
        let items = [];
        for (const s of sels.conversationItem) {
            const found = Array.from(document.querySelectorAll(s));
            if (found.length) { items = found; break; }
        }
        const folderEl = sels.folderTab.map((s) => document.querySelector(s)).find(Boolean);
        const folder = folderEl ? (folderEl.textContent || '').trim() : 'inbox';
        return items.map((it) => {
            const id = it.getAttribute(sels.conversationIdAttr) || '';
            let anchorHref = '';
            for (const s of sels.conversationAnchor) {
                const a = it.querySelector(s);
                if (a) { anchorHref = a.getAttribute('href') || ''; break; }
            }
            let fallbackId = id;
            if (!fallbackId) {
                const m = /\/messaging\/thread\/([^/?#]+)/.exec(anchorHref);
                if (m) fallbackId = m[1];
            }
            return { id: fallbackId, href: anchorHref, folder };
        });
    }, SELECTORS.MESSAGING_INBOX);

    const capped = threads.filter((t) => t.id).slice(0, MESSAGE_CAP);
    // Time estimate — each thread costs ~1 goto + 5 scrolls + extract ≈ 6 × THROTTLE_MS + ~1s overhead.
    const estSecondsPerThread = (THROTTLE_MS * 6 / 1000) + 1;
    const estMinutes = Math.ceil((capped.length * estSecondsPerThread) / 60);
    const unboundedNote = (MESSAGE_CAP === Infinity) ? '' : ` (capped at ${MESSAGE_CAP})`;
    console.log(`Scraping ${capped.length} message thread${capped.length === 1 ? '' : 's'}${unboundedNote} — estimated ${estMinutes} min. Ctrl+C to abort.`);
    const allRows = []; // [{ record, context }]

    for (let i = 0; i < capped.length; i++) {
        const t = capped[i];
        const threadUrl = t.href && t.href.startsWith('/')
            ? 'https://www.linkedin.com' + t.href
            : (t.href || SELECTORS.MESSAGE_THREAD.urlTemplate.replace('{id}', t.id));
        try {
            await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
            assertOk(page);
            await page.waitForTimeout(THROTTLE_MS);
            for (let k = 0; k < 5; k++) {
                await page.evaluate(() => {
                    const m = document.querySelector('.msg-s-message-list, ul.msg-s-message-list-content');
                    if (m) m.scrollTop = 0;
                });
                await page.waitForTimeout(THROTTLE_MS);
            }
            const threadData = await page.evaluate((sels) => {
                const pickText = (root, ss) => {
                    for (const s of ss) { const el = root.querySelector(s); if (el) return (el.textContent || '').trim(); }
                    return '';
                };
                const pickHref = (root, ss) => {
                    for (const s of ss) { const el = root.querySelector(s); if (el && el.getAttribute('href')) return el.getAttribute('href'); }
                    return '';
                };
                const title = pickText(document, sels.conversationTitle);
                let bubbles = [];
                for (const s of sels.messageBubble) {
                    const found = Array.from(document.querySelectorAll(s));
                    if (found.length) { bubbles = found; break; }
                }
                let lastFrom = '', lastUrl = '';
                return {
                    title,
                    subject: pickText(document, sels.subject),
                    bubbles: bubbles.map((b) => {
                        const fromName = pickText(b, sels.fromName);
                        const senderUrl = pickHref(b, sels.senderProfileAnchor);
                        if (fromName) lastFrom = fromName;
                        if (senderUrl) lastUrl = senderUrl;
                        let ts = '';
                        for (const s of sels.timestamp) {
                            const el = b.querySelector(s);
                            if (el) { ts = el.getAttribute('datetime') || el.textContent.trim(); break; }
                        }
                        let bodyHtml = '';
                        for (const s of sels.bodyHtml) {
                            const el = b.querySelector(s);
                            if (el) { bodyHtml = el.innerHTML; break; }
                        }
                        let hasAttach = false;
                        for (const s of sels.attachmentIndicator) {
                            if (b.querySelector(s)) { hasAttach = true; break; }
                        }
                        return {
                            fromName: fromName || lastFrom,
                            senderProfileUrl: senderUrl || lastUrl,
                            timestamp: ts, bodyHtml, hasAttachment: hasAttach,
                        };
                    }),
                };
            }, SELECTORS.MESSAGE_THREAD);

            const participants = Array.from(new Set(
                threadData.bubbles.map((b) => b.fromName).filter(Boolean)
            ));
            for (const b of threadData.bubbles) {
                allRows.push({
                    record: b,
                    context: {
                        conversationId: t.id,
                        conversationTitle: threadData.title,
                        folder: t.folder,
                        subject: threadData.subject || '',
                        participants,
                    },
                });
            }
        } catch (err) {
            if (err && err.code === 'SESSION') throw err;
        }
        if (i % 5 === 0) setProgress('messages', i, capped.length);
    }
    setProgress('messages', capped.length, capped.length);
    return allRows;
}

// --- Scrape: pending invitations (opt-in) ----------------------------------
// LinkedIn's DOM only exposes PENDING invitations — there's no history page.
// Historical invitations (who you invited in 2019 who accepted) exist ONLY in
// the ZIP export. We write pending invites to a DIFFERENT file than the ZIP's
// Invitations.csv so we don't clobber historical data.

async function scrapeInvitationsPage(page, url, direction) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    assertOk(page);
    await page.waitForTimeout(THROTTLE_MS);
    // Scroll to load all pending invitations.
    for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(THROTTLE_MS);
    }
    return page.evaluate(({ cardSelectors, direction }) => {
        let cards = [];
        for (const s of cardSelectors) {
            const found = Array.from(document.querySelectorAll(s));
            if (found.length) { cards = found; break; }
        }
        return cards.map((card) => {
            const nameEl = card.querySelector('a[href*="/in/"] span[aria-hidden="true"], a[href*="/in/"] span, .artdeco-entity-lockup__title');
            const name = (nameEl?.textContent || '').trim();
            const anchor = card.querySelector('a[href*="/in/"]');
            const href = anchor?.getAttribute('href') || '';
            const profileUrl = href.startsWith('/') ? 'https://www.linkedin.com' + href.split('?')[0] : (href.split('?')[0] || '');
            const headlineEl = card.querySelector('.artdeco-entity-lockup__subtitle, [class*="subtitle"]');
            const headline = (headlineEl?.textContent || '').trim();
            const messageEl = card.querySelector('.invitation-card__custom-message, [class*="custom-message"], blockquote');
            const message = (messageEl?.textContent || '').trim();
            const relTimeEl = card.querySelector('time, .time-badge, [class*="time"]');
            const relativeTime = (relTimeEl?.textContent || '').trim();
            return { name, profileUrl, headline, message, relativeTime, direction };
        }).filter((r) => r.profileUrl);
    }, { cardSelectors: ['li.invitation-card', 'li[data-test-invitation-card]', 'div[data-view-name="invitation-card"]', 'li[componentkey*="Invitation"]'], direction });
}

async function scrapeInvitations(page) {
    setProgress('invitations', 0, 2);
    const received = await scrapeInvitationsPage(page, 'https://www.linkedin.com/mynetwork/invitation-manager/', 'INCOMING').catch(() => []);
    setProgress('invitations', 1, 2);
    const sent = await scrapeInvitationsPage(page, 'https://www.linkedin.com/mynetwork/invitation-manager/sent/', 'OUTGOING').catch(() => []);
    setProgress('invitations', 2, 2);
    return [...received, ...sent];
}

// --- Main ------------------------------------------------------------------

async function run() {
    let lock = null;
    try {
        fs.mkdirSync(LINKEDIN_DIR, { recursive: true });
        lock = acquireLock(LOCK_PATH);
    } catch (err) {
        if (err && err.code === 'ELOCKED') {
            console.error(err.message);
            process.exitCode = 4;
            return;
        }
        throw err;
    }

    let pw;
    try { pw = loadPlaywright(); }
    catch (err) {
        console.error(err.message);
        writeStatePatch({ status: 'playwright-missing' });
        process.exitCode = 2;
        lock.release();
        return;
    }

    writeStatePatch({ status: 'syncing', progress: { phase: 'connecting', current: 0, total: 0 }, lastError: null });

    let context = null;
    let exitCode = 0;
    try {
        context = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
            headless: true,
            viewport: { width: 1440, height: 900 },
        });
        const page = context.pages()[0] || await context.newPage();

        // 1. Verify session.
        await page.goto(SELECTORS.CONNECTIONS_LIST.url, { waitUntil: 'domcontentloaded' });
        assertOk(page);

        // 2+3. Connections + detail.
        const listRecords = await scrapeConnectionsList(page);
        const detailed = await scrapeContactDetails(page, listRecords);

        // 4. Row-floor (Eng M3) then atomic write.
        try { enforceRowFloor('Connections.csv', detailed.length); }
        catch (err) {
            if (err.code === 'ROW_FLOOR') {
                writeStatePatch({
                    status: 'error',
                    lastError: { at: new Date().toISOString(), reason: 'row-count-floor', scraped: err.scraped, prior: err.prior },
                    progress: null,
                });
                console.error(err.message);
                process.exitCode = 5;
                return;
            }
            throw err;
        }
        writeCsvAtomic(STAGING_DIR, 'Connections.csv',
            toCsvFile(CONNECTIONS_HEADER, connectionRowsToCsvMatrix(detailed)));

        // 5. Messages.
        const msgRows = await scrapeMessages(page);
        const records = msgRows.map((m) => m.record);
        const contexts = new Map(msgRows.map((m) => [m.record, m.context]));
        writeCsvAtomic(STAGING_DIR, 'messages.csv',
            toCsvFile(MESSAGES_HEADER, messageRowsToCsvMatrix(records, (r) => contexts.get(r) || {})));

        // 5b. Pending invitations (opt-in). Writes a SEPARATE file — never
        // touches Invitations.csv from the ZIP. Pending-only by nature of the DOM.
        let pendingInvites = [];
        if (SCRAPE_INVITATIONS) {
            pendingInvites = await scrapeInvitations(page);
            const pendingPath = path.join(LINKEDIN_DIR, 'pending-invitations.json');
            const tmp = pendingPath + '.tmp';
            const fd = fs.openSync(tmp, 'w');
            try {
                fs.writeSync(fd, JSON.stringify({
                    scrapedAt: new Date().toISOString(),
                    note: 'Pending invitations only. Historical invitations (accepted/declined) are ZIP-only.',
                    invitations: pendingInvites,
                }, null, 2));
                fs.fsyncSync(fd);
            } finally { fs.closeSync(fd); }
            fs.renameSync(tmp, pendingPath);
        }

        await context.close();
        context = null;

        // 6. Invoke import.js with staging dir.
        setProgress('parsing', 0, 1);
        const res = spawnSync('node', [path.join(__dirname, 'import.js')], {
            env: Object.assign({}, process.env, { LINKEDIN_EXPORT_DIR: STAGING_DIR }),
            stdio: 'inherit',
        });
        if (res.status !== 0) throw new Error(`import.js exited with code ${res.status}`);

        writeStatePatch({
            status: 'connected',
            lastSync: new Date().toISOString(),
            progress: null,
            lastError: null,
        });
        const uniqThreads = new Set(msgRows.map((m) => m.context.conversationId)).size;
        const pendingMsg = SCRAPE_INVITATIONS ? `, ${pendingInvites.length} pending invites` : '';
        console.log(`Done. ${detailed.length} contacts, ${uniqThreads} threads synced${pendingMsg}.`);
    } catch (err) {
        if (context) { try { await context.close(); } catch (_) {} }
        if (err && err.code === 'SESSION') {
            writeStatePatch({
                status: err.cls === 'challenge' ? 'challenge' : 'expired',
                progress: null,
                lastError: { at: new Date().toISOString(), message: err.message },
            });
            console.error(`ERROR: LinkedIn session ${err.cls}. Run: npm run linkedin:connect`);
            exitCode = 3;
        } else if (err && err.code === 'ENOSPC') {
            writeStatePatch({
                status: 'error',
                progress: null,
                lastError: { at: new Date().toISOString(), reason: 'ENOSPC', message: err.message },
            });
            console.error('ERROR: disk full during atomic CSV write. Free some space and retry.');
            exitCode = 4;
        } else {
            writeStatePatch({
                status: 'error',
                progress: null,
                lastError: { at: new Date().toISOString(), message: (err && err.message) || String(err) },
            });
            console.error('ERROR: sync failed:', (err && err.stack) || err);
            exitCode = 1;
        }
    } finally {
        if (lock && typeof lock.release === 'function') lock.release();
    }
    if (exitCode) process.exitCode = exitCode;
}

if (require.main === module) {
    run().catch((err) => {
        console.error(err && err.stack || err);
        process.exit(1);
    });
}

module.exports = {
    run,
    writeCsvAtomic,
    enforceRowFloor,
    countCsvRows,
    sessionError,
};
