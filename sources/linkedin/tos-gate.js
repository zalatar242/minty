'use strict';

// ---------------------------------------------------------------------------
// LinkedIn ToS gate (DX-5).
//
// Automating LinkedIn is prohibited by LinkedIn's User Agreement §8.2. Before
// the user runs `linkedin:connect`, we require a typed "I accept" acknowledging
// the risk. First acceptance persists a sentinel file so subsequent runs don't
// re-prompt.
//
// This module is intentionally small and pure-ish so it's easy to unit-test:
// - normalizeInput / envBypass are pure.
// - isAccepted / recordAccept touch disk via an injectable dataDir.
// - promptAccept accepts readable/writable streams for test injection.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SENTINEL_REL = path.join('linkedin', '.tos-accepted');

// Matches an ISO-8601 timestamp string produced by Date.prototype.toISOString().
// e.g. 2026-04-23T14:22:01.123Z
const ISO_8601_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function sentinelPath(dataDir) {
    return path.join(dataDir, SENTINEL_REL);
}

/**
 * True iff `{dataDir}/linkedin/.tos-accepted` exists and contains a valid
 * ISO-8601 timestamp. Corrupted / empty / non-ISO contents are treated as
 * "not accepted" so the user is re-prompted.
 */
function isAccepted(dataDir) {
    if (!dataDir) return false;
    const file = sentinelPath(dataDir);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (_err) {
        return false;
    }
    const trimmed = String(raw).trim();
    if (!trimmed) return false;
    if (!ISO_8601_RE.test(trimmed)) return false;
    // Extra validation: Date must actually parse.
    const t = Date.parse(trimmed);
    if (Number.isNaN(t)) return false;
    return true;
}

/**
 * Write the sentinel file with the current ISO-8601 timestamp. Creates the
 * parent directory if needed.
 */
function recordAccept(dataDir) {
    if (!dataDir) throw new Error('recordAccept: dataDir is required');
    const file = sentinelPath(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString());
}

/**
 * Pure normalizer used by the prompt. Exposed for testing.
 * Returns true iff the user typed exactly "I accept" (any case, surrounding
 * whitespace allowed). Rejects "yes", "accept", "I accept.", etc.
 */
function normalizeInput(line) {
    if (line == null) return false;
    return String(line).trim().toLowerCase() === 'i accept';
}

/**
 * True iff the caller has opted into bypass via LINKEDIN_ACCEPT_TOS=1. Strict
 * '1' check — values like 'yes', 'true', or '0' do not bypass.
 */
function envBypass() {
    return process.env.LINKEDIN_ACCEPT_TOS === '1';
}

// Terse three-line warning matching the plan's ToS disclaimer (§8.2).
const TOS_WARNING = [
    'LinkedIn auto-sync is prohibited by LinkedIn User Agreement §8.2.',
    'You are responsible for your own account; Minty cannot protect you from suspension.',
    'Type "I accept" to continue (Ctrl+C to abort):',
].join('\n');

const RETRY_MSG = 'Expected exactly "I accept". Ctrl+C to abort or try again.';

/**
 * Interactive prompter. Prints the ToS warning, reads a line, normalizes it.
 * Returns true on the first matching line. On mismatch, prints the retry
 * message and re-prompts. After `attempts` failed attempts, returns false.
 *
 * `input` / `output` default to process.stdin / process.stdout but can be
 * injected (PassThrough streams) for testing.
 */
async function promptAccept(input, output, attempts = 3) {
    const inStream = input || process.stdin;
    const outStream = output || process.stdout;
    const max = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 3;

    const rl = readline.createInterface({
        input: inStream,
        output: outStream,
        terminal: false,
    });

    // Print the warning once up front.
    outStream.write(TOS_WARNING + '\n');

    // Use a persistent line queue so readline events fired in rapid
    // succession (common with PassThrough streams in tests, where all input
    // is pre-buffered) are not lost between awaits.
    const queue = [];
    const waiters = [];
    let closed = false;

    const onLine = (l) => {
        if (waiters.length > 0) {
            waiters.shift()({ line: l, done: false });
        } else {
            queue.push(l);
        }
    };
    const onClose = () => {
        closed = true;
        while (waiters.length > 0) {
            waiters.shift()({ line: null, done: true });
        }
    };
    rl.on('line', onLine);
    rl.on('close', onClose);

    const nextLine = () =>
        new Promise((resolve) => {
            if (queue.length > 0) {
                resolve({ line: queue.shift(), done: false });
                return;
            }
            if (closed) {
                resolve({ line: null, done: true });
                return;
            }
            waiters.push(resolve);
        });

    try {
        for (let i = 0; i < max; i++) {
            const { line, done } = await nextLine();
            if (done) return false;
            if (normalizeInput(line)) return true;
            // Don't bother printing the retry message after the last attempt.
            if (i < max - 1) {
                outStream.write(RETRY_MSG + '\n');
            }
        }
        return false;
    } finally {
        rl.off('line', onLine);
        rl.off('close', onClose);
        rl.close();
    }
}

module.exports = {
    isAccepted,
    recordAccept,
    normalizeInput,
    envBypass,
    promptAccept,
    // Exported for tests / introspection.
    TOS_WARNING,
    RETRY_MSG,
};
