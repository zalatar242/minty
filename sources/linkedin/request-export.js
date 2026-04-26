/**
 * sources/linkedin/request-export.js
 *
 * Submits a LinkedIn "Get a copy of your data" request on the user's behalf,
 * using the same persistent Playwright context that connect.js stashed.
 *
 * Flow:
 *   1. Open headful Chromium (so a password re-prompt — common on LinkedIn's
 *      sensitive-action pages — is solvable by the user without us
 *      intercepting credentials).
 *   2. Navigate to https://www.linkedin.com/mypreferences/d/download-my-data
 *   3. Tick the "Want a faster archive only with these categories?" radio
 *      and select Connections + Messages + Imported Contacts.
 *   4. Click "Request archive".
 *   5. Wait for the confirmation banner ("Your archive will be available...")
 *      OR a password re-prompt (we leave the window open so the user can
 *      enter their password; on success the script proceeds).
 *   6. Persist { requestedAt, categories, status: 'pending' } to
 *      data/linkedin/.export-request.json so a separate daily poll can
 *      detect when the archive is ready and auto-download.
 *
 * Exit codes:
 *   0 = request submitted (or already pending — idempotent)
 *   1 = generic failure (couldn't navigate, page changed, etc.)
 *   2 = playwright not installed
 *   3 = session expired — user needs to run `linkedin:connect` again
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');
const DEFAULT_PROFILE_DIR_REL = path.join('linkedin', 'browser-profile');
const REQUEST_STATE_REL = path.join('linkedin', '.export-request.json');
const DOWNLOAD_PAGE_URL = 'https://www.linkedin.com/mypreferences/d/download-my-data';

// Session-detection heuristics — same as fetch.js.
const { classifyUrl } = require('./session-detect');

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

// A request is "pending" if status==='pending' AND the request was made within
// the past 7 days (LinkedIn typically delivers in 24-72h; after a week it's
// almost certainly stale and we should let the user re-request).
function hasPendingRequest(state, now = Date.now()) {
    if (!state || state.status !== 'pending') return false;
    if (!state.requestedAt) return false;
    const ageMs = now - new Date(state.requestedAt).getTime();
    if (Number.isNaN(ageMs)) return false;
    return ageMs < 7 * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Playwright glue
// ---------------------------------------------------------------------------

function resolveProfileDir(dataDir) {
    if (process.env.LINKEDIN_PROFILE_DIR) return path.resolve(process.env.LINKEDIN_PROFILE_DIR);
    return path.join(dataDir, DEFAULT_PROFILE_DIR_REL);
}

async function clickFasterArchiveRadio(page) {
    // The "faster archive only with these categories" radio. LinkedIn's
    // markup uses a label-wrapping-input pattern with the visible text
    // varying ("faster archive", "specific archive", etc). Heuristic:
    // any visible radio whose label contains "faster" or "specific".
    return page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('input[type="radio"]'));
        for (const r of candidates) {
            const labelText = ((r.closest('label') || r.parentElement)?.textContent || '').toLowerCase();
            if (/faster|specific|select what you want/.test(labelText)) {
                r.scrollIntoView({ block: 'center' });
                r.click();
                return true;
            }
        }
        return false;
    });
}

async function checkCategoryBoxes(page, wanted) {
    // Tick each desired category checkbox. Returns the count actually checked.
    return page.evaluate((wantedNames) => {
        const wantedLower = wantedNames.map((n) => n.toLowerCase());
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        let checked = 0;
        for (const cb of checkboxes) {
            const labelText = ((cb.closest('label') || cb.parentElement)?.textContent || '').trim().toLowerCase();
            if (wantedLower.some((w) => labelText === w || labelText.startsWith(w + ' '))) {
                if (!cb.checked) {
                    cb.scrollIntoView({ block: 'center' });
                    cb.click();
                    checked += 1;
                }
            }
        }
        return checked;
    }, wanted);
}

async function clickRequestArchiveButton(page) {
    return page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'));
        for (const b of buttons) {
            const t = (b.textContent || '').trim().toLowerCase();
            if (/request archive/i.test(t) && !b.disabled) {
                b.scrollIntoView({ block: 'center' });
                b.click();
                return true;
            }
        }
        return false;
    });
}

async function waitForConfirmation(page, timeoutMs) {
    // LinkedIn's confirmation copy varies: "Your archive will be ready",
    // "We've started preparing", "Available archives" etc. We wait for ANY
    // of those phrases OR a download link to a *.zip in the available-archives
    // section.
    return page.waitForFunction(() => {
        const text = (document.body.innerText || '').toLowerCase();
        return /your archive will be|we['']ve started preparing|will be ready|available archives|we will email you/i.test(text);
    }, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function run(opts) {
    const options = opts || {};
    const dataDir = options.dataDir || DEFAULT_DATA_DIR;
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    const headless = options.headless ?? false; // headful by default — password re-prompts need user interaction
    const profileDir = resolveProfileDir(dataDir);

    // Idempotency: if a recent request is already pending, skip.
    const existing = readRequestState(dataDir);
    if (hasPendingRequest(existing)) {
        stdout.write(`A LinkedIn data export request is already pending (requested ${existing.requestedAt}). Wait for the email or re-run after 7 days.\n`);
        return 0;
    }

    let playwright;
    try {
        playwright = require('playwright');
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND') {
            stderr.write('Playwright not installed. Run: npm run linkedin:setup\n');
            return 2;
        }
        throw err;
    }
    const { chromium } = playwright;

    let context = null;
    try {
        context = await chromium.launchPersistentContext(profileDir, {
            headless,
            viewport: { width: 1440, height: 900 },
        });
        const page = context.pages()[0] || await context.newPage();

        await page.goto(DOWNLOAD_PAGE_URL, { waitUntil: 'domcontentloaded' });

        // Verify session — if LinkedIn redirected us to login, bail with a
        // clear "re-auth needed" exit so the caller can write the right
        // notification banner.
        const cls = classifyUrl(page.url());
        if (cls !== 'ok') {
            stderr.write(`LinkedIn session ${cls} — run 'linkedin:connect' again.\n`);
            writeRequestState(dataDir, {
                status: 'auth-required',
                requestedAt: null,
                lastError: { at: new Date().toISOString(), reason: cls },
            });
            return 3;
        }

        // Wait for the form controls to appear before interacting.
        try {
            await page.waitForFunction(
                () => document.querySelectorAll('input[type="radio"], input[type="checkbox"]').length > 0,
                { timeout: 30_000 },
            );
        } catch {
            stderr.write('Data-export form never rendered (page may have changed). Aborting.\n');
            return 1;
        }

        // 1. Tick "faster archive only with these categories".
        const radioOk = await clickFasterArchiveRadio(page);
        if (!radioOk) {
            stderr.write('Could not find the "faster archive" radio. LinkedIn may have redesigned the page.\n');
            return 1;
        }

        // Brief settle so the dependent checkboxes appear.
        await page.waitForTimeout(800);

        // 2. Tick desired categories.
        const wanted = ['Connections', 'Messages', 'Imported Contacts'];
        const checked = await checkCategoryBoxes(page, wanted);
        stdout.write(`✓ Selected ${checked} categor${checked === 1 ? 'y' : 'ies'}: ${wanted.join(', ')}\n`);
        if (checked === 0) {
            stderr.write('No category checkboxes were selectable. LinkedIn may have redesigned the page.\n');
            return 1;
        }

        // 3. Click Request archive.
        const submitted = await clickRequestArchiveButton(page);
        if (!submitted) {
            stderr.write('Could not find the "Request archive" button.\n');
            return 1;
        }

        // 4. LinkedIn often re-prompts for password here. The script just
        //    waits — the user enters it in the headful window. If they
        //    cancel or the page changes unexpectedly, the wait times out
        //    and we report.
        stdout.write('Submitted. Waiting up to 3 minutes for confirmation (LinkedIn may ask you to re-enter your password)…\n');
        const confirmed = await waitForConfirmation(page, 3 * 60 * 1000);
        if (!confirmed) {
            stderr.write('Did not see confirmation in 3 minutes. Check the headful window — you may need to re-enter your password to complete the request.\n');
            // Don't write 'pending' state because we're not sure the request
            // was accepted. User can re-run.
            return 1;
        }

        writeRequestState(dataDir, {
            status: 'pending',
            requestedAt: new Date().toISOString(),
            categories: wanted,
            confirmedVia: 'page-text',
        });
        stdout.write('✓ LinkedIn data export request submitted. They will email you when ready (typically 24-72h).\n');
        return 0;
    } catch (err) {
        stderr.write('✖ request-export failed: ' + (err && err.message ? err.message : String(err)) + '\n');
        return 1;
    } finally {
        if (context) {
            try { await context.close(); } catch { /* ignore */ }
        }
    }
}

module.exports = {
    run,
    // pure helpers exported for tests
    requestStatePath,
    readRequestState,
    writeRequestState,
    hasPendingRequest,
    DOWNLOAD_PAGE_URL,
};

if (require.main === module) {
    run().then((code) => process.exit(code), (err) => {
        process.stderr.write((err && err.stack) ? err.stack + '\n' : String(err) + '\n');
        process.exit(1);
    });
}
