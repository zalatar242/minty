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

const tosGate = require('./tos-gate');

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

        try {
            const page = await context.newPage();
            await page.goto('https://www.linkedin.com');
        } catch (err) {
            // Navigation failures aren't fatal — user may still be able to
            // navigate manually. Print a soft warning and keep going.
            const msg = err && err.message ? err.message : String(err);
            stderr.write(
                'warning: initial navigation failed (' +
                    msg +
                    '); the browser window is still open.\n'
            );
        }

        stdout.write(INSTRUCTIONS + '\n');

        // Wait for the user to close the Chromium window.
        // Wait indefinitely — logging in + 2FA + browsing takes minutes, well
        // past Playwright's default 30s. Earlier shipped version timed out
        // and claimed 'connect failed' while the user was still typing.
        await context.waitForEvent('close', { timeout: 0 });

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
