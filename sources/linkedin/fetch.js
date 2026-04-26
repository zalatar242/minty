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

// --- Resume helpers --------------------------------------------------------
// Read existing Connections.csv from prior runs so we can skip detail-fetch
// for already-enriched contacts and naturally rate-limit our LinkedIn
// queries. csv-parse is an optional dep — graceful no-op if missing.

// Same shape as the in-page looksLikeName helper, but Node-runnable so we
// can use it on CSV row data. KEEP IN SYNC with the version in
// scrapeConnectionsList's evaluate block.
const NAME_PARTICLES = new Set(['de', 'la', 'von', 'der', 'di', 'da', 'el', 'le', 'van', 'den', 'al', 'du', 'des']);
const NAME_SKIP_RE = /^(Message|Follow|Connect|Pending|Withdraw|View profile|Show all|See all|Status is online|Mutual connections?|1st(\s+degree)?|2nd|3rd|\.\.\.|⋯)$/i;

function looksLikeNameNode(s) {
    if (!s || s.length < 2 || s.length > 60) return false;
    if (/[\n@:/]/.test(s)) return false;
    if (NAME_SKIP_RE.test(s)) return false;
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 4) return false;
    for (const w of words) {
        if (NAME_PARTICLES.has(w.toLowerCase())) continue;
        if (!/^\p{Lu}/u.test(w)) return false;
    }
    return true;
}

function loadEnrichedFromCsv(filepath) {
    if (!fs.existsSync(filepath)) return new Map();
    let parse;
    try { parse = require('csv-parse/sync').parse; }
    catch { return new Map(); }
    let rows;
    try {
        const raw = fs.readFileSync(filepath, 'utf8');
        rows = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true });
    } catch { return new Map(); }
    const out = new Map();
    let excludedPolluted = 0;
    for (const r of rows) {
        const url = r['URL'] || '';
        const m = /\/in\/([^/?#]+)/.exec(url);
        if (!m) continue;
        // "Enriched" = at least one detail-pass field is populated. The
        // detail pass writes location + connectedOn (and email when shared).
        // Skip if it's just a list-phase row (no detail fields).
        const hasDetail = !!(r['Location'] || r['Connected On'] || r['Email Address']);
        if (!hasDetail) continue;
        // Pollution check: earlier versions of the href-walk parser captured
        // headline text into the name fields, so "Last Name" ended up as
        // e.g. "Merzeau Entrepreneur pragmatique". Re-validating the
        // assembled fullName against the strict name shape catches those —
        // polluted rows get excluded from the resume map so they're
        // re-fetched on the next sync (one-time cleanup; cheap because
        // most rows ARE clean once the parser is correct).
        const fullName = ((r['First Name'] || '') + ' ' + (r['Last Name'] || '')).trim();
        if (!looksLikeNameNode(fullName)) {
            excludedPolluted++;
            continue;
        }
        out.set(m[1], r);
    }
    if (excludedPolluted > 0) {
        console.log(`[linkedin/fetch] resume: excluded ${excludedPolluted} polluted-name rows from prior runs — they'll be re-fetched with the corrected parser`);
    }
    return out;
}

function slugFromProfileUrl(url) {
    const m = /\/in\/([^/?#]+)/.exec(url || '');
    return m ? m[1] : null;
}

// Convert a row from Connections.csv (column-keyed) into the shape that
// scrapeContactDetails returns (camelCase fields), so resumed rows merge
// cleanly with freshly-scraped ones.
function csvRowToConnectionRecord(row, baseFromList) {
    return {
        ...baseFromList,
        // Don't trust the CSV's name parts — they go through splitName from
        // fullName at write time. Keep baseFromList's fullName/profileUrl.
        email: row['Email Address'] || '',
        company: row['Company'] || baseFromList.company || '',
        position: row['Position'] || baseFromList.position || '',
        connectedOn: row['Connected On'] || '',
        location: row['Location'] || '',
    };
}
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

// Per-thread message scrape parallelism. Same shape as DETAIL_CONCURRENCY:
// each worker is a tab against the same authenticated context. Defaults
// to DETAIL_CONCURRENCY so users tuning that value get matching behaviour
// for both phases. Override with LINKEDIN_MESSAGE_CONCURRENCY=N.
const MESSAGE_CONCURRENCY = (() => {
    const raw = process.env.LINKEDIN_MESSAGE_CONCURRENCY;
    if (!raw) return DETAIL_CONCURRENCY;
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

    // domcontentloaded fires before LinkedIn's React app paints the list —
    // body can still be empty for several seconds. Wait until at least one
    // /in/ link has rendered, or we know the page is genuinely empty
    // (rate-limit / soft-block / challenge served as a 200 with empty body).
    try {
        await page.waitForFunction(
            () => document.querySelectorAll('a[href*="/in/"]').length > 0,
            { timeout: 30_000 },
        );
    } catch {
        const len = await page.evaluate(() => (document.body.innerText || '').length);
        console.log(`[linkedin/fetch] connections page never rendered any /in/ links after 30s (body=${len} chars). LinkedIn may be rate-limiting headless traffic — try again in a few minutes.`);
    }

    // Read the visible "X connections" header so we know the target count
    // and can show real progress / detect short reads. The "X connections"
    // text can render after the first /in/ links land (or use a non-breaking
    // space / singular "connection"), so retry up to 3x with a small delay.
    const readExpectedTotal = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const n = await page.evaluate(() => {
                const m = (document.body.innerText || '').match(/([\d,]+)\s*connections?\b/i);
                return m ? Number(m[1].replace(/,/g, '')) : null;
            });
            if (n) return n;
            await page.waitForTimeout(500);
        }
        return null;
    };
    let expectedTotal = await readExpectedTotal();
    if (expectedTotal) console.log(`[linkedin/fetch] page reports ${expectedTotal.toLocaleString()} total connections`);

    // Drive infinite-scroll by repeatedly scrolling the last profile-link
    // card into view. window.scrollTo(body.scrollHeight) doesn't trigger
    // anything when the connections list lives inside an inner scroll
    // container (the 2026 layout). scrollIntoView on the deepest visible
    // /in/ link works regardless of which ancestor is scrollable.
    //
    // When the count plateaus we (a) wait longer (back-off lets LinkedIn's
    // rate limiter recover) and (b) look for any "Show more" / "Load more"
    // / "See more" button to click — some chunk boundaries pause
    // auto-loading until you press one.
    const STALL_THRESHOLD = 25;
    let lastCount = 0, stableTicks = 0;
    for (let i = 0; i < MAX_CONNECTIONS && stableTicks < STALL_THRESHOLD; i++) {
        const count = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/in/"]'))
                .filter((a) => !a.closest('nav, header'));
            if (links.length) {
                links[links.length - 1].scrollIntoView({ block: 'end' });
            }
            // Belt-and-suspenders: also nudge window + main scrolling root.
            try { window.scrollBy(0, 2000); } catch {}
            try { (document.scrollingElement || document.documentElement).scrollTop += 2000; } catch {}

            // Click any visible "Show more" / "Load more" / "See more" button.
            // LinkedIn sometimes pauses infinite-scroll at chunk boundaries
            // until you press one — without this we'd plateau at a few hundred
            // even though thousands more exist.
            for (const b of document.querySelectorAll('button')) {
                const t = (b.textContent || '').trim();
                if (/^(show|load|see)\s+more(\s+results?)?$/i.test(t) && !b.disabled) {
                    const r = b.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) { b.click(); break; }
                }
            }
            return links.length;
        });
        // Back-off: wait longer when we're stalled so LinkedIn's lazy-load
        // (and any post-button-click XHR) has time to land.
        const waitMs = THROTTLE_MS + Math.min(stableTicks * THROTTLE_MS, THROTTLE_MS * 6);
        await page.waitForTimeout(waitMs);
        if (count === lastCount) stableTicks++;
        else { stableTicks = 0; lastCount = count; }
        // Capture page state JUST BEFORE we give up — one tick before the
        // for-loop's stall guard exits. Lets us diagnose plateaus without
        // having to reproduce a multi-thousand-connection scrape.
        if (stableTicks === STALL_THRESHOLD - 1) {
            try {
                const debugDir = path.join(LINKEDIN_DIR, '.debug');
                fs.mkdirSync(debugDir, { recursive: true });
                const ts = Date.now();
                const pngPath = path.join(debugDir, `connections-stalled-${ts}.png`);
                const htmlPath = path.join(debugDir, `connections-stalled-${ts}.html`);
                await page.screenshot({ path: pngPath, fullPage: true });
                fs.writeFileSync(htmlPath, await page.content());
                console.log(`[linkedin/fetch] scroll stalled at count=${count}${expectedTotal ? '/' + expectedTotal : ''} — diagnostic at ${pngPath} and ${htmlPath}`);
            } catch (e) { console.error('[linkedin/fetch] stalled-scroll debug failed:', e.message); }
        }
        // Progress every 5 iterations OR when we cross every 100-row mark.
        if (i % 5 === 0 || (count >= 100 && Math.floor(count / 100) > Math.floor(lastCount / 100))) {
            setProgress('connections', count, expectedTotal || -1);
            console.log(`[linkedin/fetch] scroll i=${i} count=${count}${expectedTotal ? '/' + expectedTotal : ''} stalled=${stableTicks}`);
        }
        if (expectedTotal && count >= expectedTotal) break; // we have everything
    }

    let records = await page.evaluate((sels) => {
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

    // Fallback when LinkedIn's DOM has drifted past our static selectors.
    // We enumerate every unique /in/<slug>/ link on the page, climb to the
    // tightest ancestor that owns exactly that one profile-link (the "card"),
    // and parse name + headline from its first visible text lines.
    if (records.length === 0) {
        records = await page.evaluate(() => {
            const out = [];
            const SKIP_NAME = /^(Message|Follow|Connect|Pending|Withdraw|View profile|Show all|See all|Status is online|Mutual connections?|1st(\s+degree)?|2nd|3rd|\.\.\.|⋯)$/i;
            // Real names: 1-4 capitalized words separated by single spaces, with
            // optional lowercase particles (de, la, von, der, di...). Anything
            // longer is almost certainly headline-text bleeding in (LinkedIn
            // links sometimes wrap the entire row, so a.textContent picks up
            // the headline too — that's how we ended up with
            // "Pierre Merzeau Entrepreneur pragmatique" as a single "name").
            const PARTICLES = new Set(['de', 'la', 'von', 'der', 'di', 'da', 'el', 'le', 'van', 'den', 'al', 'du', 'des']);
            const looksLikeName = (s) => {
                if (!s || s.length < 2 || s.length > 60) return false;
                if (/[\n@:/]/.test(s)) return false;
                if (SKIP_NAME.test(s)) return false;
                const words = s.split(/\s+/);
                if (words.length === 0 || words.length > 4) return false;
                for (const w of words) {
                    if (!w) continue;
                    if (PARTICLES.has(w.toLowerCase())) continue;
                    // Non-particle words must start with a capital letter
                    // (Latin or accented). Catches "Entrepreneur pragmatique"
                    // because "pragmatique" is lowercase.
                    if (!/^\p{Lu}/u.test(w)) return false;
                }
                return true;
            };

            // Group anchors by slug — each connection gets ~2 anchors on the
            // page (avatar + name). We pick whichever has the most useful
            // info and skip the rest.
            const bySlug = new Map();
            for (const a of document.querySelectorAll('a[href*="/in/"]')) {
                const m = (a.getAttribute('href') || '').match(/\/in\/([^/?#]+)/);
                if (!m) continue;
                if (a.closest('nav, header')) continue;
                const slug = m[1];
                if (!bySlug.has(slug)) bySlug.set(slug, []);
                bySlug.get(slug).push(a);
            }

            for (const anchors of bySlug.values()) {
                let fullName = '';
                let occupation = '';
                let chosenAnchor = anchors[0];

                // Strategy 1: aria-label / aria-hidden span / direct text on
                // any of the anchors (LinkedIn's accessible-name pattern
                // varies by anchor — try each). Strip "View NAME's profile"
                // boilerplate from aria-label since LinkedIn uses both that
                // and the bare-name form across the page.
                const tryExtractFromAria = (raw) => {
                    if (!raw) return '';
                    const t = raw.trim();
                    const m = t.match(/^view\s+(.+?)(?:['']s\s+profile|\s+profile|,\s|$)/i);
                    return m && m[1] ? m[1].trim() : t;
                };
                for (const a of anchors) {
                    const aria = tryExtractFromAria(a.getAttribute('aria-label'));
                    if (looksLikeName(aria)) { fullName = aria; chosenAnchor = a; break; }
                    const hiddenSpan = a.querySelector('[aria-hidden="true"]');
                    const hiddenTxt = hiddenSpan ? (hiddenSpan.textContent || '').trim() : '';
                    if (looksLikeName(hiddenTxt)) { fullName = hiddenTxt; chosenAnchor = a; break; }
                    // a.textContent includes ALL nested text, which is wrong
                    // when the link wraps a whole row. Only use it when the
                    // anchor itself is a leaf (no element children).
                    if (a.children.length === 0) {
                        const direct = (a.textContent || '').replace(/\s+/g, ' ').trim();
                        if (looksLikeName(direct)) { fullName = direct; chosenAnchor = a; break; }
                    }
                }

                // Strategy 2: card-climb. Stop when the parent owns >1
                // *distinct* slugs (was: any second /in/ link, which
                // double-counted each connection's avatar+name).
                {
                    let card = chosenAnchor;
                    for (let i = 0; i < 8; i++) {
                        const parent = card.parentElement;
                        if (!parent) break;
                        const others = new Set();
                        for (const oa of parent.querySelectorAll('a[href*="/in/"]')) {
                            const om = (oa.getAttribute('href') || '').match(/\/in\/([^/?#]+)/);
                            if (om) others.add(om[1]);
                        }
                        if (others.size > 1) break;
                        card = parent;
                    }
                    const lines = (card.innerText || '')
                        .split('\n').map((s) => s.trim()).filter(Boolean)
                        .filter((s) => !SKIP_NAME.test(s));
                    if (!fullName && lines.length && looksLikeName(lines[0])) fullName = lines[0];
                    // Find occupation as the first non-name, non-skip line
                    for (const ln of lines) {
                        if (ln === fullName) continue;
                        if (/^Connected on /i.test(ln)) continue; // date noise
                        if (looksLikeName(ln) && ln.length > 5) { occupation = ln; break; }
                    }
                }

                if (!fullName) continue;
                out.push({
                    fullName,
                    profileUrl: chosenAnchor.href,
                    occupation,
                });
            }
            return out;
        });
        if (records.length > 0) console.log(`[linkedin/fetch] static selectors empty — fell back to href-walk and found ${records.length} connections`);
    }

    // Diagnostic: short read (got far fewer than the "X connections" header
    // promised). Save HTML + screenshot so we can fix the scroll strategy or
    // selector logic without another scrape round-trip.
    if (expectedTotal && records.length < Math.min(expectedTotal * 0.5, expectedTotal - 5)) {
        try {
            const debugDir = path.join(LINKEDIN_DIR, '.debug');
            fs.mkdirSync(debugDir, { recursive: true });
            const ts = Date.now();
            await page.screenshot({ path: path.join(debugDir, `connections-short-${ts}.png`), fullPage: true });
            fs.writeFileSync(path.join(debugDir, `connections-short-${ts}.html`), await page.content());
            console.log(`[linkedin/fetch] short read: scraped ${records.length} of ${expectedTotal} connections — diagnostic at ${debugDir}/connections-short-${ts}.{png,html}`);
        } catch (e) { console.error('[linkedin/fetch] short-read debug failed:', e.message); }
    }

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
    let email = '', connectedOn = '', location = '';
    try {
        await page.goto(overlayUrl, { waitUntil: 'domcontentloaded' });
        assertOk(page);
        // The overlay URL also loads the underlying profile page; we read
        // location from there in the same evaluate so we don't pay a
        // second navigation per contact (would double total scrape time).
        ({ email, connectedOn, location } = await page.evaluate((sels) => {
            const pickAttr = (ss, attr) => {
                for (const s of ss) { const el = document.querySelector(s); if (el && el.getAttribute(attr)) return el.getAttribute(attr); }
                return '';
            };
            const pickText = (ss) => {
                for (const s of ss) { const el = document.querySelector(s); if (el) return (el.textContent || '').trim(); }
                return '';
            };
            const mailto = pickAttr(sels.email, 'href');

            // Location heuristic: LinkedIn's profile-card location label is a
            // small, leaf text element near the headline matching a
            // "City, Region[, Country]" pattern (or a metro like
            // "San Francisco Bay Area"). DOM classes drift, so we look for
            // structural signals: short text, leaf node, geographic shape.
            const LOC_RE = /^[A-ZÀ-Ý][\p{L}'.\- ]+(?:,\s*[A-ZÀ-Ý][\p{L}'.\- ]+){0,3}$/u;
            const looksLikeLocation = (s) => {
                if (!s || s.length < 3 || s.length > 100) return false;
                if (/^(About|Experience|Education|Skills|Activity|Projects|Languages|Interests|Recommendations|Contact info|Connections?|Followers?)/i.test(s)) return false;
                if (/[@:/]|^https?/i.test(s)) return false;
                return LOC_RE.test(s);
            };
            // Try common selectors first.
            const locSelectors = [
                'div[data-test-profile-location]',
                'div.text-body-small.inline.t-black--light.break-words',
                'span.text-body-small.inline.t-black--light.break-words',
                '.pv-text-details__left-panel .text-body-small',
            ];
            let loc = '';
            for (const s of locSelectors) {
                const el = document.querySelector(s);
                if (el && looksLikeLocation((el.textContent || '').trim())) {
                    loc = (el.textContent || '').trim();
                    break;
                }
            }
            // Fallback: scan the top profile section for leaf nodes that
            // look location-shaped. Stop at the first match — order matters
            // because LinkedIn renders the headline above the location.
            if (!loc) {
                const top = document.querySelector('main') || document.body;
                if (top) {
                    const candidates = top.querySelectorAll('section span, section div');
                    for (const el of candidates) {
                        if (el.children.length > 0) continue; // leaf only
                        const t = (el.textContent || '').trim();
                        if (looksLikeLocation(t)) { loc = t; break; }
                    }
                }
            }

            return {
                email: mailto ? mailto.replace(/^mailto:/i, '').trim() : pickText(sels.email),
                connectedOn: pickText(sels.connectedOn).replace(/^connected\s+/i, '').trim(),
                location: loc,
            };
        }, SELECTORS.CONTACT_INFO_MODAL));
    } catch (err) {
        if (err && err.code === 'SESSION') throw err;
        // Individual overlay failures are non-fatal.
    }
    return Object.assign({}, c, { email, connectedOn, location });
}

async function scrapeContactDetails(context, connections, opts = {}) {
    if (SKIP_DETAILS) return connections;
    const total = connections.length;
    const results = new Array(total);
    let cursor = 0, done = 0;
    let sessionErr = null;
    const onBatch = typeof opts.onBatch === 'function' ? opts.onBatch : null;
    const batchEvery = Number(opts.batchEvery) || 50;
    // Resume: pre-fill `results` for any contact whose enriched row is
    // already on disk. The workers below then skip them — fewer LinkedIn
    // queries, less rate-limit risk. Each resumed contact is logged at
    // 'details' progress without ever opening a tab.
    const existing = (opts.existing instanceof Map) ? opts.existing : new Map();
    let resumedCount = 0;
    if (existing.size > 0) {
        for (let i = 0; i < total; i++) {
            const slug = slugFromProfileUrl(connections[i].profileUrl);
            if (slug && existing.has(slug)) {
                results[i] = csvRowToConnectionRecord(existing.get(slug), connections[i]);
                resumedCount++;
            }
        }
        if (resumedCount > 0) {
            console.log(`[linkedin/fetch] resuming: ${resumedCount}/${total} contacts already enriched on disk — skipping their detail-fetch`);
            done = resumedCount;
            setProgress('details', done, total);
            if (onBatch) {
                try { onBatch(connections.map((c, i) => results[i] || c), done, total); }
                catch { /* ignore */ }
            }
        }
    }

    // Returns the in-progress full array — entries enriched so far, the rest
    // fall back to the raw list record. So callers can write a partial CSV
    // at any time without losing not-yet-detailed rows.
    function snapshot() {
        return connections.map((c, i) => results[i] || c);
    }

    async function worker(workerIndex) {
        const page = workerIndex === 0 ? context.pages()[0] || await context.newPage() : await context.newPage();
        try {
            while (true) {
                if (sessionErr) break;
                const idx = cursor++;
                if (idx >= total) break;
                // Resume: skip the actual fetch when this slot was pre-filled
                // from the on-disk CSV. Saves a LinkedIn page-load per
                // already-known contact — the whole point of this branch.
                if (results[idx] !== undefined) continue;
                try {
                    results[idx] = await scrapeOneContactDetail(page, connections[idx]);
                } catch (err) {
                    if (err && err.code === 'SESSION') { sessionErr = err; break; }
                    results[idx] = connections[idx];
                }
                done++;
                if (done % 10 === 0 || done === total) setProgress('details', done, total);
                if (onBatch && (done % batchEvery === 0 || done === total)) {
                    try { onBatch(snapshot(), done, total); }
                    catch (e) { /* don't let a flush error kill the scrape */ }
                }
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
    return connections.map((c, i) => results[i] || c);
}

// --- Scrape: messaging -----------------------------------------------------

async function scrapeMessages(context, page) {
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

    // Per-thread work, hoisted out of the loop so a worker pool can dispatch
    // it concurrently. Returns the rows for this thread (or [] on failure).
    // Throws only on SESSION errors so they propagate up and abort the whole
    // scrape — everything else is logged and swallowed per-thread.
    async function scrapeOneThread(wpage, t) {
        const threadUrl = t.href && t.href.startsWith('/')
            ? 'https://www.linkedin.com' + t.href
            : (t.href || SELECTORS.MESSAGE_THREAD.urlTemplate.replace('{id}', t.id));
        try {
            await wpage.goto(threadUrl, { waitUntil: 'domcontentloaded' });
            assertOk(wpage);
            await wpage.waitForTimeout(THROTTLE_MS);
            // Adaptive scroll: load older messages by scrolling to top repeatedly,
            // but stop as soon as two consecutive scrolls don't load new bubbles.
            let prevCount = -1, stableStreak = 0;
            for (let k = 0; k < 8; k++) {
                const count = await wpage.evaluate((sels) => {
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
                if (count === prevCount) { stableStreak++; if (stableStreak >= 2) break; }
                else { stableStreak = 0; prevCount = count; }
                await wpage.waitForTimeout(THROTTLE_MS);
            }
            const threadData = await wpage.evaluate((sels) => {
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
            return threadData.bubbles.map((b) => ({
                record: b,
                context: {
                    conversationId: t.id,
                    conversationTitle: threadData.title,
                    folder: t.folder,
                    subject: threadData.subject || '',
                    participants,
                },
            }));
        } catch (err) {
            if (err && err.code === 'SESSION') throw err;
            return [];
        }
    }

    // Worker pool — mirrors scrapeContactDetails's shape. Worker 0 reuses
    // the inbox-enumeration page; siblings spawn their own. Output keyed by
    // thread index so we can flatten preserving original thread order.
    const rowsByThread = new Array(capped.length);
    let cursor = 0, done = 0, sessionErr = null;

    async function worker(workerIndex) {
        const wpage = workerIndex === 0 ? page : await context.newPage();
        try {
            while (true) {
                if (sessionErr) return;
                const idx = cursor++;
                if (idx >= capped.length) return;
                try {
                    rowsByThread[idx] = await scrapeOneThread(wpage, capped[idx]);
                } catch (err) {
                    if (err && err.code === 'SESSION') { sessionErr = err; return; }
                    rowsByThread[idx] = [];
                }
                done++;
                if (done % 5 === 0 || done === capped.length) {
                    setProgress('messages', done, capped.length);
                }
            }
        } finally {
            if (workerIndex !== 0) { try { await wpage.close(); } catch { /* ignore */ } }
        }
    }

    const workerCount = Math.min(MESSAGE_CONCURRENCY, capped.length);
    if (workerCount > 1) console.log(`[linkedin/fetch] message threads parallelized across ${workerCount} tabs`);
    await Promise.all(Array.from({ length: Math.max(workerCount, 1) }, (_, i) => worker(i)));
    if (sessionErr) throw sessionErr;

    setProgress('messages', capped.length, capped.length);
    return rowsByThread.flatMap((rows) => rows || []);
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
        // Diagnostic: if scraping returns zero connections (stale selectors,
        // headless detection, throttled session), save a screenshot + the
        // landing-page URL so the user has something to inspect.
        if (listRecords.length === 0) {
            try {
                const debugDir = path.join(LINKEDIN_DIR, '.debug');
                fs.mkdirSync(debugDir, { recursive: true });
                const ts = Date.now();
                const shotPath = path.join(debugDir, `connections-empty-${ts}.png`);
                await page.screenshot({ path: shotPath, fullPage: true });
                fs.writeFileSync(path.join(debugDir, `connections-empty-${ts}.url`), page.url());
                // Also dump the HTML so we can iterate selectors locally
                // without another scrape round-trip.
                const html = await page.content();
                fs.writeFileSync(path.join(debugDir, `connections-empty-${ts}.html`), html);
                console.log(`[linkedin/fetch] 0 connections returned — diagnostic screenshot at ${shotPath}`);
                console.log(`[linkedin/fetch] page URL: ${page.url()}`);
                console.log(`[linkedin/fetch] HTML dump at ${path.join(debugDir, `connections-empty-${ts}.html`)}`);
            } catch (e) { console.error('[linkedin/fetch] debug capture failed:', e.message); }
        }
        // Resume: load existing enriched rows so we don't re-fetch contacts
        // we already have full data on. This is the main rate-limit lever —
        // a second sync run only hits LinkedIn for new connections + ones
        // that haven't been detail-enriched yet, often dropping query volume
        // by >90%.
        const existingEnriched = loadEnrichedFromCsv(path.join(STAGING_DIR, 'Connections.csv'));
        if (existingEnriched.size > 0) {
            console.log(`[linkedin/fetch] resume: ${existingEnriched.size} contacts already enriched in staging CSV — will skip their detail-fetch`);
        }

        // Early CSV flush — write list-only data BEFORE the slow detail
        // pass. If the user Ctrl+C's during details, they keep all the
        // names/URLs/occupations from the list phase. Detail-pass enrichment
        // (email, location, connectedOn) layers in via incremental flushes
        // every batchEvery completions. We MERGE with existingEnriched so
        // the early-write doesn't clobber prior detail data on disk.
        if (listRecords.length > 0) {
            try {
                const merged = listRecords.map((c) => {
                    const slug = slugFromProfileUrl(c.profileUrl);
                    if (slug && existingEnriched.has(slug)) {
                        return csvRowToConnectionRecord(existingEnriched.get(slug), c);
                    }
                    return c;
                });
                writeCsvAtomic(STAGING_DIR, 'Connections.csv',
                    toCsvFile(CONNECTIONS_HEADER, connectionRowsToCsvMatrix(merged)));
                console.log(`[linkedin/fetch] early-write Connections.csv with ${listRecords.length} rows (${existingEnriched.size} carried over from prior runs)`);
            } catch (e) {
                console.error('[linkedin/fetch] early CSV write failed:', e.message);
            }
        }

        const detailed = await scrapeContactDetails(context, listRecords, {
            batchEvery: 50,
            existing: existingEnriched,
            onBatch: (snapshot, done, total) => {
                try {
                    writeCsvAtomic(STAGING_DIR, 'Connections.csv',
                        toCsvFile(CONNECTIONS_HEADER, connectionRowsToCsvMatrix(snapshot)));
                    if (done % 250 === 0 || done === total) {
                        console.log(`[linkedin/fetch] flushed Connections.csv at ${done}/${total} detail pass`);
                    }
                } catch (e) {
                    console.error('[linkedin/fetch] incremental CSV flush failed:', e.message);
                }
            },
        });

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
        const msgRows = await scrapeMessages(context, page);
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
