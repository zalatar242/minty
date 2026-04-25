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

// Default 1000ms between page navigations. Humans click faster than 2s; 1s is
// still well within human-like bounds while cutting scrape time roughly in half.
// Bump higher if you want to be extra cautious, lower if you're willing to
// accept slightly more risk for speed.
const THROTTLE_MS = Number(process.env.LINKEDIN_THROTTLE_MS) || 1000;
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
// Parallelism for the per-contact detail backfill. Default 3 tabs — same
// authenticated session, LinkedIn sees multi-tab browsing (common in humans).
// Higher = faster but more concurrent requests; higher detection risk.
// 0 / invalid / empty = use default of 3. Explicit 1 = serial.
const DETAIL_CONCURRENCY = (() => {
    const raw = process.env.LINKEDIN_DETAIL_CONCURRENCY;
    if (!raw) return 3;
    const n = Number(raw);
    return (!Number.isFinite(n) || n < 1) ? 1 : Math.floor(n);
})();

// --- sync-state.json -------------------------------------------------------
// Delegated to sources/linkedin/sync-state.js which handles atomic writes
// (openSync + fsyncSync + rename). We hold the lock during the entire scrape,
// so racing writers aren't the concern — atomic write protects against
// power-loss / process-kill leaving a truncated sync-state.json on disk.

const syncState = require('./sync-state');
const DATA_DIR = path.join(ROOT, 'data');

function writeStatePatch(patch) {
    try { syncState.writeLinkedIn(DATA_DIR, patch); } catch (_) { /* best-effort */ }
}
function setProgress(phase, current, total) {
    try { syncState.setProgress(DATA_DIR, phase, current, total); } catch (_) { /* best-effort */ }
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

// --- Scrape: per-contact detail (parallelized across N tabs) ---------------
// Previously serial — one goto per contact, ~2.5h for 3600 contacts. Now a
// worker pool of DETAIL_CONCURRENCY tabs against the same persistent context
// (shared session cookie, just parallel DOM instances). Same per-tab rate
// limiting; total throughput ≈ DETAIL_CONCURRENCY × serial throughput.

async function scrapeOneContactDetail(page, c) {
    const slugMatch = c.profileUrl && /\/in\/([^/?#]+)/.exec(c.profileUrl);
    if (!slugMatch) return c;
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
    return Object.assign({}, c, { email, connectedOn });
}

async function scrapeContactDetails(context, connections) {
    if (SKIP_DETAILS) return connections;
    const total = connections.length;
    const results = new Array(total);
    // Shared cursor to allocate indices to workers; shared done counter for progress.
    let cursor = 0, done = 0;
    let sessionErr = null;

    async function worker(workerIndex) {
        const page = workerIndex === 0 ? context.pages()[0] || await context.newPage() : await context.newPage();
        try {
            while (true) {
                if (sessionErr) break;
                const idx = cursor++;
                if (idx >= total) break;
                try {
                    results[idx] = await scrapeOneContactDetail(page, connections[idx]);
                } catch (err) {
                    if (err && err.code === 'SESSION') { sessionErr = err; break; }
                    results[idx] = connections[idx];
                }
                done++;
                if (done % 10 === 0 || done === total) setProgress('details', done, total);
                await sleep(THROTTLE_MS);
            }
        } finally {
            if (workerIndex !== 0) { try { await page.close(); } catch (_) {} }
        }
    }

    const workerCount = Math.min(DETAIL_CONCURRENCY, total);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
    if (sessionErr) throw sessionErr;
    setProgress('details', total, total);
    // Preserve original order; any missing (race condition, shouldn't happen) falls back to input.
    return connections.map((c, i) => results[i] || c);
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
            // Best-effort last-activity timestamp. ISO first (from <time> attrs),
            // falls back to visible text ("2h", "Yesterday", "Jan 15"). Used
            // only to skip unchanged threads on incremental syncs — when in
            // doubt (missing/unparsable), we scrape.
            let lastIso = '';
            for (const s of (sels.threadTimestampIso || [])) {
                const el = it.querySelector(s);
                if (el) {
                    lastIso = el.getAttribute('datetime') || el.getAttribute('title') || '';
                    if (lastIso) break;
                }
            }
            let lastText = '';
            for (const s of (sels.threadTimestampText || [])) {
                const el = it.querySelector(s);
                if (el) { lastText = (el.textContent || '').trim(); if (lastText) break; }
            }
            return { id: fallbackId, href: anchorHref, folder, lastIso, lastText };
        });
    }, SELECTORS.MESSAGING_INBOX);

    // Incremental skip: on repeat runs, skip threads whose last-activity is
    // clearly older than sync-state.json.linkedin.lastSync. Unparsable or
    // missing timestamps → scrape (safe fallback). First run (no lastSync) →
    // scrape everything.
    let filtered = threads.filter((t) => t.id);
    const linkedinState = syncState.readLinkedIn(DATA_DIR) || {};
    const lastSyncMs = linkedinState.lastSync ? Date.parse(linkedinState.lastSync) : null;
    let skippedAsUnchanged = 0;
    if (lastSyncMs && !Number.isNaN(lastSyncMs)) {
        const before = filtered.length;
        filtered = filtered.filter((t) => {
            const iso = t.lastIso ? Date.parse(t.lastIso) : NaN;
            if (!Number.isNaN(iso)) return iso > lastSyncMs; // clean skip signal
            // No ISO — try to parse common relative forms. Be conservative:
            // anything we don't recognize, scrape.
            const text = (t.lastText || '').toLowerCase();
            // Very recent (seconds / minutes / hours / "now") — always newer than any lastSync.
            if (/^\d+s$/.test(text) || /^\d+m$/.test(text) || /^\d+h$/.test(text) || text === 'now' || text === 'just now') return true;
            // "Yesterday" thread is ~24h old. Newer than lastSync iff lastSync > 24h ago.
            if (/yesterday/.test(text)) return Date.now() - lastSyncMs > 24 * 3600 * 1000;
            // Relative Nd / Nw / Nmo / Ny. The thread is roughly (N × unit) old;
            // it's newer than lastSync iff (now - age) > lastSync.
            const relUnits = [
                [/^(\d+)d$/, 86400 * 1000],
                [/^(\d+)w$/, 7 * 86400 * 1000],
                [/^(\d+)mo$/, 30 * 86400 * 1000],
                [/^(\d+)y$/, 365 * 86400 * 1000],
            ];
            for (const [re, unitMs] of relUnits) {
                const m = re.exec(text);
                if (m) return (Date.now() - Number(m[1]) * unitMs) > lastSyncMs;
            }
            // Absolute "Jan 15" / "jan 15" / "Mar 3" — no year. Try current year;
            // if the result lies in the future (e.g. Dec in January), it was last year.
            const absMatch = /^([a-z]{3})\s+(\d{1,2})$/.exec(text);
            if (absMatch) {
                const year = new Date().getFullYear();
                const tryA = Date.parse(`${absMatch[1]} ${absMatch[2]}, ${year}`);
                if (!Number.isNaN(tryA)) {
                    const resolved = tryA > Date.now()
                        ? Date.parse(`${absMatch[1]} ${absMatch[2]}, ${year - 1}`)
                        : tryA;
                    if (!Number.isNaN(resolved)) return resolved > lastSyncMs;
                }
            }
            return true; // unknown format → scrape (safe fallback)
        });
        skippedAsUnchanged = before - filtered.length;
    }
    const capped = filtered.slice(0, MESSAGE_CAP);
    // Time estimate — adaptive scroll typically stabilizes in 1-2 iterations.
    // Per-thread cost ≈ goto + 2 × THROTTLE_MS on average + ~1s extract.
    const estSecondsPerThread = (THROTTLE_MS * 2 / 1000) + 1.5;
    const estMinutes = Math.ceil((capped.length * estSecondsPerThread) / 60);
    const unboundedNote = (MESSAGE_CAP === Infinity) ? '' : ` (capped at ${MESSAGE_CAP})`;
    const skipNote = skippedAsUnchanged > 0
        ? ` (${skippedAsUnchanged} thread${skippedAsUnchanged === 1 ? '' : 's'} skipped as unchanged since last sync)`
        : '';
    console.log(`Scraping ${capped.length} message thread${capped.length === 1 ? '' : 's'}${unboundedNote}${skipNote} — estimated ${estMinutes} min. Ctrl+C to abort.`);
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
            // Adaptive scroll: load older messages by scrolling to top repeatedly,
            // but stop as soon as two consecutive scrolls don't load new bubbles.
            // Most threads have < 50 messages and stabilize in 1-2 scrolls; the
            // old fixed 5-iteration loop wasted 3-4 scrolls on those. Capped at 8
            // iterations so pathological threads can't hang.
            let prevCount = -1, stableStreak = 0;
            for (let k = 0; k < 8; k++) {
                const count = await page.evaluate((sels) => {
                    for (const s of sels.container) {
                        const m = document.querySelector(s);
                        if (m) { m.scrollTop = 0; break; }
                    }
                    for (const s of sels.bubble) {
                        const found = document.querySelectorAll(s);
                        if (found.length) return found.length;
                    }
                    return 0;
                }, { container: SELECTORS.MESSAGE_THREAD.messageListContainer, bubble: SELECTORS.MESSAGE_THREAD.messageBubble });
                // Two consecutive stable counts = done. Single-tick stability
                // is too eager on slow networks where LinkedIn lazy-loads —
                // count might plateau briefly between batches.
                if (count === prevCount) { stableStreak++; if (stableStreak >= 2) break; }
                else { stableStreak = 0; prevCount = count; }
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
        const detailed = await scrapeContactDetails(context, listRecords);

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
        // Use process.execPath so nvm / multi-node-version setups invoke the
        // same node binary as the parent, not whatever `node` happens to be in PATH.
        const res = spawnSync(process.execPath, [path.join(__dirname, 'import.js')], {
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
