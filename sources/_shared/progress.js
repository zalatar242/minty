/**
 * Shared per-source progress tracker.
 *
 * Every importer writes its own `.progress.json` inside its source directory,
 * using the same shape. The CRM server reads these files to render:
 *   - GET /api/sources/:key/progress          — one source
 *   - GET /api/sync/progress                  — all in-flight sources
 *
 * Shape of a progress record:
 *   {
 *     source: "whatsapp" | "linkedin" | "telegram" | "email" | "sms" | "googleContacts" | "apollo",
 *     step:   "init" | "contacts" | "messages" | "merging" | "done" | "error",
 *     message: string,
 *     current?: number,
 *     total?:   number,
 *     itemsProcessed?: number,
 *     errors?: string[],
 *     startedAt: ISO,
 *     updatedAt: ISO,
 *     error?: { message, stack? },
 *   }
 *
 * Writes are best-effort: a failed write never crashes the importer.
 * `active` is derived from `step !== 'done' && step !== 'error'`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = {
    whatsapp:       'whatsapp',
    linkedin:       'linkedin',
    telegram:       'telegram',
    email:          'email',
    sms:            'sms',
    googleContacts: 'google-contacts',
    apollo:         'apollo',
};

// Legacy file used by crm/server.js handleWhatsappProgress. We keep writing to
// this path *as well* so nothing breaks, plus the new canonical `.progress.json`.
const LEGACY_PATHS = {
    whatsapp: '.export-progress.json',
};

function sourceDir(dataDir, source) {
    const name = SOURCE_DIR[source] || source;
    return path.join(dataDir, name);
}

function progressPath(dataDir, source) {
    return path.join(sourceDir(dataDir, source), '.progress.json');
}

function legacyProgressPath(dataDir, source) {
    const legacy = LEGACY_PATHS[source];
    return legacy ? path.join(sourceDir(dataDir, source), legacy) : null;
}

function safeWrite(filePath, payload) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(payload));
        fs.renameSync(tmp, filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Build a progress payload with derived fields.
 * `base` may include any of { source, step, message, current, total, itemsProcessed, errors, startedAt, error }.
 */
function buildPayload(prev, patch) {
    const now = new Date().toISOString();
    const merged = {
        source: patch.source || (prev && prev.source),
        step: patch.step || (prev && prev.step) || 'init',
        message: patch.message !== undefined ? patch.message : (prev && prev.message) || '',
        current: patch.current !== undefined ? patch.current : (prev && prev.current),
        total: patch.total !== undefined ? patch.total : (prev && prev.total),
        itemsProcessed: patch.itemsProcessed !== undefined ? patch.itemsProcessed : (prev && prev.itemsProcessed),
        errors: patch.errors !== undefined ? patch.errors : (prev && prev.errors) || undefined,
        error: patch.error !== undefined ? patch.error : (prev && prev.error) || undefined,
        startedAt: (prev && prev.startedAt) || patch.startedAt || now,
        updatedAt: now,
    };
    // Drop undefined keys so the JSON stays tidy
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    return merged;
}

/**
 * Called once when an importer begins. Safe to call even if a prior run left
 * a stale progress file behind — startedAt gets reset.
 */
function startProgress(dataDir, source, initial = {}) {
    const payload = buildPayload(null, {
        source,
        step: 'init',
        message: 'Starting…',
        startedAt: new Date().toISOString(),
        ...initial,
    });
    return writeProgress(dataDir, source, payload, /*replace=*/true);
}

/**
 * Merges `patch` into the existing progress file. Callers typically pass
 * { step, message, current, total }.
 */
function updateProgress(dataDir, source, patch = {}) {
    const prev = readProgress(dataDir, source);
    const payload = buildPayload(prev, { source, ...patch });
    return writeProgress(dataDir, source, payload, /*replace=*/false);
}

/**
 * Mark the run as done. `summary` may include any final counts ({ messages, contacts }).
 */
function finishProgress(dataDir, source, summary = {}) {
    const prev = readProgress(dataDir, source);
    const payload = buildPayload(prev, {
        source,
        step: 'done',
        message: summary.message || 'Done.',
        current: summary.current !== undefined ? summary.current : (prev && prev.current),
        total: summary.total !== undefined ? summary.total : (prev && prev.total),
        itemsProcessed: summary.itemsProcessed !== undefined ? summary.itemsProcessed : (prev && prev.itemsProcessed),
    });
    return writeProgress(dataDir, source, payload, /*replace=*/false);
}

/**
 * Mark the run as failed. The payload keeps the last known progress plus the
 * error so the UI can show "failed at X/Y — <message>".
 */
function failProgress(dataDir, source, error) {
    const prev = readProgress(dataDir, source);
    const payload = buildPayload(prev, {
        source,
        step: 'error',
        message: error && error.message ? error.message : 'Failed.',
        error: error ? { message: error.message, stack: error.stack && String(error.stack).split('\n').slice(0, 5).join('\n') } : undefined,
    });
    return writeProgress(dataDir, source, payload, /*replace=*/false);
}

function writeProgress(dataDir, source, payload, replace = false) {
    // If replacing, drop any prior error / done state so the new run reads cleanly.
    if (replace) {
        payload = { ...payload };
    }
    const ok = safeWrite(progressPath(dataDir, source), payload);
    const legacy = legacyProgressPath(dataDir, source);
    if (legacy) safeWrite(legacy, payload);
    return ok;
}

function readProgress(dataDir, source) {
    const candidates = [progressPath(dataDir, source), legacyProgressPath(dataDir, source)].filter(Boolean);
    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!raw.source) raw.source = source;
            return raw;
        } catch { /* try next */ }
    }
    return null;
}

function clearProgress(dataDir, source) {
    for (const p of [progressPath(dataDir, source), legacyProgressPath(dataDir, source)].filter(Boolean)) {
        try { fs.unlinkSync(p); } catch {}
    }
}

function isActive(record) {
    if (!record) return false;
    return record.step !== 'done' && record.step !== 'error';
}

function percent(record) {
    if (!record || !record.total || record.total <= 0) return null;
    const cur = Math.max(0, Math.min(record.total, record.current || 0));
    return Math.round((cur / record.total) * 100);
}

/**
 * List every source with a progress file, whether still in-flight or finished.
 * Result is keyed by source name.
 */
function listProgress(dataDir) {
    const out = {};
    for (const key of Object.keys(SOURCE_DIR)) {
        const p = readProgress(dataDir, key);
        if (p) out[key] = p;
    }
    return out;
}

/**
 * List only active (in-flight) progress records, sorted oldest-first so the UI
 * can show the longest-running one first.
 */
function listActive(dataDir) {
    const all = listProgress(dataDir);
    const active = {};
    for (const [key, rec] of Object.entries(all)) if (isActive(rec)) active[key] = rec;
    return active;
}

module.exports = {
    SOURCE_DIR,
    progressPath,
    startProgress,
    updateProgress,
    finishProgress,
    failProgress,
    readProgress,
    clearProgress,
    listProgress,
    listActive,
    isActive,
    percent,
    buildPayload, // exposed for tests
};
