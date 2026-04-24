'use strict';

// ---------------------------------------------------------------------------
// LinkedIn auto-sync: headful connect flow.
//
// Launches a visible Chromium window against a persistent profile dir so the
// user can log into LinkedIn (including 2FA / device challenges). When the
// user closes the window, we record sync-state.json.linkedin.status =
// "connected" and exit.
//
// See plan: /home/sree/.gstack/projects/zalatar242-minty/sree-emdash-shaggy-
// birds-admire-9uo-design-20260423-073201.md, sections "Data flow", "Eng C2"
// (profile dir perms), "DX-5" (ToS gate), and "State schema".
//
// The file is primarily a CLI entry point, but the pure helpers
// (readSyncState, writeSyncState, updateLinkedInState, ensureProfileDir) are
// exported for unit testing without requiring Playwright.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const tosGate = require('./tos-gate');
const credentials = require('./credentials');
const { totp, secondsUntilNext } = require('./totp');
const SELECTORS = require('./selectors');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');
const DEFAULT_SYNC_STATE_REL = 'sync-state.json';
const DEFAULT_PROFILE_DIR_REL = path.join('linkedin', 'browser-profile');

// ---------------------------------------------------------------------------
// Pure-ish helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Read & parse sync-state.json. Returns {} on ENOENT, parse error, or empty.
 * Any other error propagates.
 */
function readSyncState(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return {};
        throw err;
    }
    const trimmed = String(raw).trim();
    if (!trimmed) return {};
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    } catch (_err) {
        return {};
    }
}

/**
 * Atomic write of sync-state.json via .tmp + rename. Creates parent dir if
 * needed. Pretty-prints with 2-space indent (matches existing file style).
 */
function writeSyncState(filePath, state) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    const body = JSON.stringify(state, null, 2) + '\n';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, filePath);
}

/**
 * Merge partial updates into the `linkedin` key of sync-state.json. Preserves
 * all other top-level keys and any existing `linkedin.*` fields not overridden
 * by `updates`. Returns the updated state object.
 */
function updateLinkedInState(filePath, updates) {
    const state = readSyncState(filePath);
    const prev =
        state.linkedin && typeof state.linkedin === 'object'
            ? state.linkedin
            : {};
    state.linkedin = Object.assign({}, prev, updates || {});
    writeSyncState(filePath, state);
    return state;
}

/**
 * Ensure the profile dir exists with mode 0o700. If it exists but has any
 * group/other permission bits (mode & 0o077 !== 0), throws an Error with a
 * message the CLI can print directly. Addresses Eng C2.
 */
function ensureProfileDir(dir) {
    if (!dir) throw new Error('ensureProfileDir: dir is required');
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    const st = fs.statSync(dir);
    // On platforms that don't honour mode bits (eg. Windows), mode & 0o077
    // will typically be 0 anyway; this check is a no-op there.
    if ((st.mode & 0o077) !== 0) {
        const err = new Error(
            'Profile dir permissions too loose. Run: chmod 700 ' +
                dir +
                ' and retry.'
        );
        err.code = 'EPERM_TOO_LOOSE';
        throw err;
    }
    return dir;
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
    'LinkedIn Connect',
    '',
    'A Chromium window should have opened. Log into LinkedIn there, solve any 2FA,',
    'and wait until you see your feed/home page.',
    '',
    'Then close the Chromium window (or press Ctrl+C in this terminal).',
].join('\n');

const AUTO_INSTRUCTIONS = [
    'LinkedIn Auto-Connect',
    '',
    'Using stored credentials. Chromium is logging in for you.',
    'If LinkedIn prompts for a challenge we can\'t handle (SMS, device verify,',
    'CAPTCHA), the window will stay open for you to complete manually.',
].join('\n');

// --- Interactive creds prompter ---------------------------------------------
// Reads email, password, optional TOTP secret from stdin. Password input is
// echoed (readline doesn't do masking cleanly cross-platform — for a local
// single-user CLI that's OK, and it avoids a native-terminal dep). Users
// uncomfortable with that should type the creds into data/linkedin/credentials.json
// by hand (chmod 600 first).

function promptLine(stdin, stdout, question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

async function promptForCreds(stdin, stdout) {
    stdout.write([
        '',
        'LinkedIn credential setup',
        '',
        'These are stored LOCALLY at data/linkedin/credentials.json with 0o600.',
        'Minty never sends them anywhere. If your machine is multi-user or',
        'unencrypted, Ctrl+C now and use the manual flow instead.',
        '',
    ].join('\n'));
    const email = (await promptLine(stdin, stdout, 'LinkedIn email: ')).trim();
    const password = await promptLine(stdin, stdout, 'LinkedIn password (echoes on screen): ');
    stdout.write([
        '',
        'TOTP secret (optional). If you enable "Authenticator app" 2FA in',
        'LinkedIn → Settings → Sign in & security → Two-step verification,',
        'LinkedIn shows a base32 string before the QR code — that\'s the secret.',
        'Leave blank if you don\'t have one; you\'ll handle 2FA manually.',
        '',
    ].join('\n'));
    const totpRaw = (await promptLine(stdin, stdout, 'TOTP secret (blank to skip): ')).trim();
    const creds = { email, password };
    if (totpRaw) creds.totpSecret = totpRaw;
    return creds;
}

// --- Auto-login -------------------------------------------------------------

async function firstMatching(page, selectors, { timeout = 5000 } = {}) {
    // Playwright's page.waitForSelector only takes one selector. We race an
    // Array.from + querySelector poll instead so multiple candidates work.
    const started = Date.now();
    while (Date.now() - started < timeout) {
        for (const s of selectors) {
            const el = await page.$(s);
            if (el) return { el, selector: s };
        }
        await page.waitForTimeout(250);
    }
    return null;
}

async function isLoggedIn(page) {
    const url = page.url();
    for (const p of SELECTORS.LOGIN.successUrlPatterns) {
        if (url.includes(p)) return true;
    }
    return false;
}

async function isChallengeActive(page) {
    const url = page.url();
    for (const p of SELECTORS.CHALLENGE.urlPatterns) {
        if (url.includes(p)) return true;
    }
    // Also detect a TOTP input on the current page (URL patterns aren't
    // exhaustive — LinkedIn sometimes keeps you on /login for challenges).
    return !!(await firstMatching(page, SELECTORS.CHALLENGE.totpInput, { timeout: 1000 }));
}

/**
 * Attempt automated login. Returns true on success, false if we hit a
 * challenge we can't handle (SMS, device verify, CAPTCHA). On false, the
 * caller should fall through to the manual flow (keep window open).
 */
async function tryAutoLogin(page, creds, { stderr } = {}) {
    const writeStderr = (stderr && stderr.write) ? stderr.write.bind(stderr) : () => {};
    await page.goto(SELECTORS.LOGIN.url, { waitUntil: 'domcontentloaded' });
    // If already signed in (cookie from prior session), LinkedIn redirects
    // straight to /feed — skip the form entirely.
    await page.waitForTimeout(1000);
    if (await isLoggedIn(page)) return true;

    const emailHit = await firstMatching(page, SELECTORS.LOGIN.emailInput);
    const pwHit = await firstMatching(page, SELECTORS.LOGIN.passwordInput);
    if (!emailHit || !pwHit) {
        writeStderr('auto-login: login form not found, falling back to manual.\n');
        return false;
    }
    await page.fill(emailHit.selector, creds.email);
    await page.fill(pwHit.selector, creds.password);
    const submitHit = await firstMatching(page, SELECTORS.LOGIN.submitButton);
    if (!submitHit) {
        writeStderr('auto-login: submit button not found, falling back to manual.\n');
        return false;
    }
    await page.click(submitHit.selector);

    // Wait up to 15s for either success URL or a challenge page.
    const started = Date.now();
    while (Date.now() - started < 15000) {
        await page.waitForTimeout(500);
        if (await isLoggedIn(page)) return true;
        if (await isChallengeActive(page)) break;
    }

    // Challenge path — we can only handle TOTP if the user stored a secret.
    if (!creds.totpSecret) {
        writeStderr('auto-login: 2FA required but no TOTP secret stored. Falling back to manual.\n');
        return false;
    }

    const totpHit = await firstMatching(page, SELECTORS.CHALLENGE.totpInput, { timeout: 5000 });
    if (!totpHit) {
        writeStderr('auto-login: challenge page present but no TOTP input found (may be SMS/device verify). Falling back to manual.\n');
        return false;
    }

    // If we're within 3s of the code rotating, wait for the next window so
    // LinkedIn doesn't reject the code we're about to type.
    if (secondsUntilNext(Date.now()) < 3) {
        await page.waitForTimeout(3500);
    }
    const code = totp(creds.totpSecret);
    await page.fill(totpHit.selector, code);
    const totpSubmit = await firstMatching(page, SELECTORS.CHALLENGE.totpSubmit);
    if (!totpSubmit) {
        writeStderr('auto-login: TOTP submit button not found. Falling back to manual.\n');
        return false;
    }
    await page.click(totpSubmit.selector);

    // Wait up to 15s more for success.
    const started2 = Date.now();
    while (Date.now() - started2 < 15000) {
        await page.waitForTimeout(500);
        if (await isLoggedIn(page)) return true;
        // If we got kicked back to the challenge page, TOTP was wrong.
        if (await isChallengeActive(page)) {
            // Give LinkedIn a moment — sometimes the page briefly re-renders.
            await page.waitForTimeout(2000);
            if (!(await isLoggedIn(page))) {
                writeStderr('auto-login: TOTP rejected or secondary challenge appeared. Falling back to manual.\n');
                return false;
            }
        }
    }
    writeStderr('auto-login: timed out waiting for feed redirect. Falling back to manual.\n');
    return false;
}

/**
 * Resolve the profile dir from env or a default under dataDir.
 */
function resolveProfileDir(dataDir) {
    if (process.env.LINKEDIN_PROFILE_DIR) {
        return path.resolve(process.env.LINKEDIN_PROFILE_DIR);
    }
    return path.join(dataDir, DEFAULT_PROFILE_DIR_REL);
}

/**
 * Main entry point. Returns the exit code (number). CLI wrapper at bottom of
 * file handles the process.exit call.
 *
 * Options (all optional):
 *   - dataDir: override the data dir (default: <repo>/data)
 *   - stdin, stdout, stderr: injected streams for testing
 */
async function run(opts) {
    const options = opts || {};
    const dataDir = options.dataDir || DEFAULT_DATA_DIR;
    const stdin = options.stdin || process.stdin;
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;

    const syncStatePath = path.join(dataDir, DEFAULT_SYNC_STATE_REL);
    const profileDir = resolveProfileDir(dataDir);

    // 1. Playwright guard.
    let playwright;
    try {
        playwright = require('playwright');
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND') {
            stderr.write(
                'Playwright not installed. Run: npm run linkedin:setup\n'
            );
            return 2;
        }
        throw err;
    }

    // 2/3. Ensure profile dir exists + perms are tight.
    try {
        ensureProfileDir(profileDir);
    } catch (err) {
        stderr.write((err && err.message ? err.message : String(err)) + '\n');
        return 1;
    }

    // 4. ToS gate.
    if (!tosGate.envBypass() && !tosGate.isAccepted(dataDir)) {
        let accepted = false;
        try {
            accepted = await tosGate.promptAccept(stdin, stdout);
        } catch (err) {
            stderr.write(
                '✖ connect failed: ' +
                    (err && err.message ? err.message : String(err)) +
                    '\n'
            );
            return 1;
        }
        if (!accepted) {
            stderr.write('ToS acceptance required. Exiting.\n');
            return 1;
        }
        try {
            tosGate.recordAccept(dataDir);
        } catch (err) {
            stderr.write(
                '✖ connect failed: ' +
                    (err && err.message ? err.message : String(err)) +
                    '\n'
            );
            return 1;
        }
    } else if (tosGate.envBypass() && !tosGate.isAccepted(dataDir)) {
        // First run with env bypass still records sentinel per DX-5.
        try {
            tosGate.recordAccept(dataDir);
        } catch (_err) {
            // Non-fatal — continue regardless.
        }
    }

    // 4.5. Credentials: offer to save, or load existing. Three env toggles:
    //   LINKEDIN_SAVE_CREDS=1  → interactive prompt, write to creds store
    //   LINKEDIN_FORGET_CREDS=1→ delete stored creds, then fall through
    //   LINKEDIN_MANUAL=1      → force manual flow even if stored creds exist
    let storedCreds = null;
    if (process.env.LINKEDIN_FORGET_CREDS === '1') {
        try {
            credentials.remove(dataDir);
            stdout.write('Stored LinkedIn credentials removed.\n');
        } catch (err) {
            stderr.write('failed to remove credentials: ' + (err.message || err) + '\n');
        }
    }
    if (process.env.LINKEDIN_SAVE_CREDS === '1') {
        try {
            const entered = await promptForCreds(stdin, stdout);
            credentials.write(dataDir, entered);
            storedCreds = entered;
            stdout.write('✓ Credentials saved to ' + credentials.credPath(dataDir) + ' (mode 0600).\n');
        } catch (err) {
            stderr.write('✖ credential setup failed: ' + (err.message || err) + '\n');
            return 1;
        }
    } else if (process.env.LINKEDIN_MANUAL !== '1') {
        try {
            storedCreds = credentials.read(dataDir);
        } catch (err) {
            stderr.write('warning: ' + (err.message || err) + '\n');
            storedCreds = null;
        }
    }

    // 5/6. Launch Chromium + wait for close.
    const { chromium } = playwright;
    let context = null;
    let sigintHandler = null;
    let sigtermHandler = null;

    const closeContextSafely = async () => {
        if (!context) return;
        try {
            await context.close();
        } catch (_err) {
            // best-effort
        }
    };

    try {
        try {
            context = await chromium.launchPersistentContext(profileDir, {
                headless: false,
                viewport: { width: 1440, height: 900 },
            });
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            stderr.write('✖ connect failed: ' + msg + '\n');
            try {
                updateLinkedInState(syncStatePath, {
                    status: 'error',
                    lastError: {
                        at: new Date().toISOString(),
                        message: msg,
                    },
                });
            } catch (_stateErr) {
                // best-effort
            }
            return 1;
        }

        // 9. Signal safety: close context before exiting on Ctrl+C/SIGTERM.
        sigintHandler = () => {
            closeContextSafely().finally(() => process.exit(130));
        };
        sigtermHandler = () => {
            closeContextSafely().finally(() => process.exit(143));
        };
        process.on('SIGINT', sigintHandler);
        process.on('SIGTERM', sigtermHandler);

        let autoLoggedIn = false;
        const page = await context.newPage();
        if (storedCreds) {
            stdout.write(AUTO_INSTRUCTIONS + '\n');
            try {
                autoLoggedIn = await tryAutoLogin(page, storedCreds, { stderr });
            } catch (err) {
                stderr.write(
                    'auto-login threw: ' + (err.message || String(err)) +
                    '. Falling back to manual.\n'
                );
                autoLoggedIn = false;
            }
        } else {
            try {
                await page.goto('https://www.linkedin.com');
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                stderr.write(
                    'warning: initial navigation failed (' + msg +
                    '); the browser window is still open.\n'
                );
            }
        }

        if (!autoLoggedIn) {
            // Manual path — user completes login / challenge in the window.
            // timeout: 0 = wait indefinitely; logging in + 2FA takes minutes.
            stdout.write(INSTRUCTIONS + '\n');
            await context.waitForEvent('close', { timeout: 0 });
        } else {
            // Auto-login succeeded. Close context immediately and move on.
            stdout.write('✓ Auto-login succeeded. Saving session...\n');
            await context.close();
            context = null;
        }

        // 7. Success — record state.
        try {
            updateLinkedInState(syncStatePath, {
                status: 'connected',
                mode: 'auto-sync',
                lastConnectAt: new Date().toISOString(),
                lastError: null,
            });
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            stderr.write('✖ connect failed: ' + msg + '\n');
            return 1;
        }

        stdout.write(
            '✓ LinkedIn session saved to ' +
                profileDir +
                '. Run `npm run linkedin:sync` to sync your data.\n'
        );
        return 0;
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        stderr.write('✖ connect failed: ' + msg + '\n');
        try {
            updateLinkedInState(syncStatePath, {
                status: 'error',
                lastError: { at: new Date().toISOString(), message: msg },
            });
        } catch (_stateErr) {
            // best-effort
        }
        return 1;
    } finally {
        if (sigintHandler) process.off('SIGINT', sigintHandler);
        if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
        // If we reached here without the context already being closed (eg.
        // we errored mid-flow), make sure we don't leave Chromium orphaned.
        await closeContextSafely();
    }
}

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

if (require.main === module) {
    run()
        .then((code) => {
            process.exit(typeof code === 'number' ? code : 0);
        })
        .catch((err) => {
            process.stderr.write(
                '✖ connect failed: ' +
                    (err && err.message ? err.message : String(err)) +
                    '\n'
            );
            process.exit(1);
        });
}

module.exports = {
    run,
    readSyncState,
    writeSyncState,
    updateLinkedInState,
    ensureProfileDir,
    resolveProfileDir,
    // Exposed for introspection / tests.
    INSTRUCTIONS,
};
