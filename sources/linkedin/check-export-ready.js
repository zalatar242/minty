/**
 * sources/linkedin/check-export-ready.js
 *
 * Polls LinkedIn's data-export page to see if an archive previously requested
 * by request-export.js is now ready, downloads it, unzips it, and feeds it to
 * sources/linkedin/import.js.
 *
 * Designed to be invoked once a day by the sync daemon — idempotent,
 * exits cleanly when there's nothing to do.
 *
 * Flow:
 *   1. Skip if no pending request, or last-checked < 23h ago.
 *   2. Open headless Chromium with the persistent profile (uses connect.js's
 *      saved session — no QR/password unless it's expired).
 *   3. Navigate to https://www.linkedin.com/mypreferences/d/download-my-data
 *   4. Look for an "Available archives" download button/link.
 *   5. Download the ZIP via context.request.get(url) (authenticated cookies)
 *      OR via Playwright's download event (when the button triggers a JS
 *      download flow).
 *   6. Unzip to a temp dir, run import.js with LINKEDIN_EXPORT_DIR set.
 *   7. Mark .export-request.json as 'completed' so we stop polling.
 *
 * Exit codes:
 *   0 = success (downloaded + imported, OR no-pending-request, OR archive
 *       still being prepared by LinkedIn — caller should check the returned
 *       `status` to differentiate)
 *   1 = generic failure (page changed, network error, unzip failed)
 *   2 = playwright not installed
 *   3 = session expired — needs re-auth
 *   4 = unzip not available on this system
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { classifyUrl } = require('./session-detect');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');
const DEFAULT_PROFILE_DIR_REL = path.join('linkedin', 'browser-profile');
const REQUEST_STATE_REL = path.join('linkedin', '.export-request.json');
const DOWNLOAD_DIR_REL = path.join('linkedin', '.export-downloads');
const DOWNLOAD_PAGE_URL = 'https://www.linkedin.com/mypreferences/d/download-my-data';
const POLL_THROTTLE_MS = 23 * 60 * 60 * 1000; // skip if checked in the last 23h

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

function requestStatePath(dataDir) {
    return path.join(dataDir, REQUEST_STATE_REL);
}

function readRequestState(dataDir) {
    try {
        const raw = fs.readFileSync(requestStatePath(dataDir), 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}

function writeRequestState(dataDir, state) {
    const p = requestStatePath(dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch { /* Windows etc. */ }
}

// True iff there's a 'pending' request that hasn't been checked recently.
function shouldPoll(state, now = Date.now()) {
    if (!state || state.status !== 'pending' || !state.requestedAt) return false;
    const ageMs = now - new Date(state.requestedAt).getTime();
    if (Number.isNaN(ageMs)) return false;
    if (ageMs > 7 * 24 * 60 * 60 * 1000) return false; // > 1 week — let user re-request
    if (state.lastCheckedAt) {
        const sinceCheck = now - new Date(state.lastCheckedAt).getTime();
        if (!Number.isNaN(sinceCheck) && sinceCheck < POLL_THROTTLE_MS) return false;
    }
    return true;
}

function unzipAvailable() {
    const r = spawnSync('unzip', ['-v'], { stdio: 'ignore' });
    return r.status === 0;
}

// ---------------------------------------------------------------------------
// Playwright glue
// ---------------------------------------------------------------------------

function resolveProfileDir(dataDir) {
    if (process.env.LINKEDIN_PROFILE_DIR) return path.resolve(process.env.LINKEDIN_PROFILE_DIR);
    return path.join(dataDir, DEFAULT_PROFILE_DIR_REL);
}

// Locate a "Download archive" button/link on the data-export page. Returns:
//   { kind: 'href',   url: '<authenticated download url>' }
//   { kind: 'button', clickIndex: <nth matching button> }   — needs page click
//   null when nothing matches (archive still being prepared)
async function findDownloadTarget(page) {
    return page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        for (const a of links) {
            const t = (a.textContent || '').trim();
            const href = a.getAttribute('href') || '';
            if (/^download archive$/i.test(t) || (/download/i.test(t) && /\.zip\b/i.test(href))) {
                if (href) return { kind: 'href', url: a.href };
            }
        }
        const buttons = Array.from(document.querySelectorAll('button'));
        for (let i = 0; i < buttons.length; i++) {
            const b = buttons[i];
            const t = (b.textContent || '').trim();
            if (/^download archive$/i.test(t) && !b.disabled) {
                return { kind: 'button', clickIndex: i };
            }
        }
        return null;
    });
}

async function downloadArchive(context, page, target, zipPath) {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    if (target.kind === 'href') {
        // Use the authenticated context's request API so cookies attach.
        const res = await context.request.get(target.url);
        if (!res.ok()) throw new Error(`download failed: HTTP ${res.status()}`);
        const body = await res.body();
        fs.writeFileSync(zipPath, body);
        return zipPath;
    }
    // Button click — Playwright captures the download event.
    const downloadPromise = page.waitForEvent('download', { timeout: 5 * 60 * 1000 });
    await page.evaluate((idx) => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const b = buttons[idx];
        if (b) b.click();
    }, target.clickIndex);
    const dl = await downloadPromise;
    await dl.saveAs(zipPath);
    return zipPath;
}

function unzipTo(zipPath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`unzip exited with code ${r.status}`);
}

function runImporter(extractDir, dataDir) {
    const importerPath = path.resolve(__dirname, 'import.js');
    const env = {
        ...process.env,
        LINKEDIN_EXPORT_DIR: extractDir,
        LINKEDIN_OUT_DIR: path.join(dataDir, 'linkedin'),
        CRM_DATA_DIR: dataDir,
    };
    const r = spawnSync(process.execPath, [importerPath], { env, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`import.js exited with code ${r.status}`);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function run(opts) {
    const options = opts || {};
    const dataDir = options.dataDir || DEFAULT_DATA_DIR;
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    const force = options.force === true || process.env.LINKEDIN_FORCE_EXPORT_CHECK === '1';

    const state = readRequestState(dataDir);
    if (!force && !shouldPoll(state)) {
        const why = !state ? 'no request on file'
            : state.status !== 'pending' ? `request status is "${state.status}"`
            : 'checked recently (or request > 7 days old)';
        stdout.write(`[linkedin/check-export] skipping: ${why}\n`);
        return 0;
    }

    if (!unzipAvailable()) {
        stderr.write('unzip command not found on PATH. Install it (apt install unzip / brew install unzip) and retry.\n');
        writeRequestState(dataDir, { ...(state || {}), lastError: { at: new Date().toISOString(), reason: 'unzip-missing' } });
        return 4;
    }

    let playwright;
    try { playwright = require('playwright'); }
    catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND') {
            stderr.write('Playwright not installed.\n'); return 2;
        }
        throw err;
    }
    const profileDir = resolveProfileDir(dataDir);

    let context = null;
    try {
        context = await playwright.chromium.launchPersistentContext(profileDir, {
            headless: true,
            viewport: { width: 1440, height: 900 },
        });
        const page = context.pages()[0] || await context.newPage();
        await page.goto(DOWNLOAD_PAGE_URL, { waitUntil: 'domcontentloaded' });

        const cls = classifyUrl(page.url());
        if (cls !== 'ok') {
            stderr.write(`LinkedIn session ${cls} — re-auth needed.\n`);
            writeRequestState(dataDir, { ...(state || {}), status: 'auth-required', lastCheckedAt: new Date().toISOString() });
            return 3;
        }

        // Wait briefly for either the "still preparing" message or an
        // "Available archives" section.
        try {
            await page.waitForFunction(
                () => /available archive|download archive|your archive will|we['']ve started preparing|will be ready|currently preparing/i.test(document.body.innerText || ''),
                { timeout: 30_000 },
            );
        } catch {
            // Page didn't render an expected phrase — record + bail.
            writeRequestState(dataDir, { ...(state || {}), lastCheckedAt: new Date().toISOString(), lastError: { at: new Date().toISOString(), reason: 'page-render-timeout' } });
            stderr.write('Data-export page did not render in 30s.\n');
            return 1;
        }

        const target = await findDownloadTarget(page);
        if (!target) {
            stdout.write('Archive not ready yet — LinkedIn is still preparing it. Will check again tomorrow.\n');
            writeRequestState(dataDir, { ...(state || {}), lastCheckedAt: new Date().toISOString() });
            return 0;
        }

        // Download.
        const zipPath = path.join(dataDir, DOWNLOAD_DIR_REL, `archive-${Date.now()}.zip`);
        stdout.write(`Archive ready — downloading to ${zipPath}...\n`);
        await downloadArchive(context, page, target, zipPath);
        stdout.write(`✓ Downloaded ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB\n`);

        // Unzip + import.
        const extractDir = zipPath.replace(/\.zip$/, '');
        unzipTo(zipPath, extractDir);
        stdout.write(`✓ Unzipped to ${extractDir}\n`);
        runImporter(extractDir, dataDir);
        stdout.write('✓ Imported\n');

        writeRequestState(dataDir, {
            ...(state || {}),
            status: 'completed',
            completedAt: new Date().toISOString(),
            archivePath: zipPath,
            lastCheckedAt: new Date().toISOString(),
        });
        return 0;
    } catch (err) {
        stderr.write('✖ check-export failed: ' + (err && err.message ? err.message : String(err)) + '\n');
        writeRequestState(dataDir, { ...(state || {}), lastCheckedAt: new Date().toISOString(), lastError: { at: new Date().toISOString(), message: String(err && err.message || err).slice(0, 240) } });
        return 1;
    } finally {
        if (context) { try { await context.close(); } catch { /* ignore */ } }
    }
}

module.exports = {
    run,
    requestStatePath,
    readRequestState,
    writeRequestState,
    shouldPoll,
    findDownloadTarget,
    DOWNLOAD_PAGE_URL,
    POLL_THROTTLE_MS,
};

if (require.main === module) {
    run().then((code) => process.exit(code), (err) => {
        process.stderr.write((err && err.stack) ? err.stack + '\n' : String(err) + '\n');
        process.exit(1);
    });
}
