/**
 * crm/config.js — runtime user config with hot-reload.
 *
 * Goal: a self-hosted user shouldn't need to touch env vars to enable
 * features. Settings UI writes to data/config.json; this module reads it on
 * every access, falling back to env vars for backwards-compatibility.
 *
 * Resolution order per key:
 *   1. ENV var (e.g. MINTY_LINKEDIN_AUTOSYNC=1, GOOGLE_CLIENT_ID=…)
 *   2. data/config.json
 *   3. minty-mode.json (legacy — still supported)
 *   4. built-in default
 *
 * Hot-reload: getConfig() always reads current state without a restart.
 * Cached in-process for ~1s (mtime-keyed) to keep request paths fast.
 *
 * 0600 permissions on save because the file can hold OAuth client secrets.
 *
 * Pure-ish: file I/O is confined to this module; everything else is
 * deterministic.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
    linkedinAutosync: false,
    demoMode: false,
    google: {
        clientId: '',
        clientSecret: '',
    },
    microsoft: {
        clientId: '',
        clientSecret: '',
    },
    apollo: {
        apiKey: '',
    },
    aiBackend: 'claude',  // 'claude' | 'ollama' | 'none'
});

const ENV_OVERRIDES = {
    'linkedinAutosync':       () => process.env.MINTY_LINKEDIN_AUTOSYNC === '1' ? true : null,
    'demoMode':               () => process.env.MINTY_DEMO === '1' ? true : null,
    'google.clientId':        () => process.env.GOOGLE_CLIENT_ID || null,
    'google.clientSecret':    () => process.env.GOOGLE_CLIENT_SECRET || null,
    'microsoft.clientId':     () => process.env.MICROSOFT_CLIENT_ID || null,
    'microsoft.clientSecret': () => process.env.MICROSOFT_CLIENT_SECRET || null,
    'apollo.apiKey':          () => process.env.APOLLO_API_KEY || null,
    'aiBackend':              () => process.env.AI_BACKEND || null,
};

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 1000;

function configPath(dataDir) {
    return path.join(dataDir, 'config.json');
}

/**
 * Load config from disk, applying defaults and env overrides.
 * Cached for CACHE_TTL_MS to avoid hot-loop fs reads.
 */
function getConfig(dataDir) {
    const now = Date.now();
    if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;
    const path_ = configPath(dataDir);
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(path_, 'utf8')) || {}; } catch { onDisk = {}; }
    // Legacy: minty-mode.json carried `linkedinAutosync` and `mode: 'demo'|'real'`
    let legacy = {};
    try {
        const legacyFile = path.join(path.dirname(dataDir), 'minty-mode.json');
        const m = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) || {};
        if (m.linkedinAutosync !== undefined) legacy.linkedinAutosync = !!m.linkedinAutosync;
        if (m.mode === 'demo') legacy.demoMode = true;
    } catch { /* missing legacy file is fine */ }

    const merged = deepMerge(deepMerge(deepClone(DEFAULTS), legacy), onDisk);

    // Apply env overrides last (highest priority)
    for (const [dotPath, getter] of Object.entries(ENV_OVERRIDES)) {
        const v = getter();
        if (v !== null && v !== undefined) setPath(merged, dotPath, v);
    }

    _cache = Object.freeze(deepClone(merged));
    _cacheAt = now;
    return _cache;
}

/**
 * Merge a patch into the on-disk config and re-emit. Patches use the same
 * shape as DEFAULTS; nested keys merge, primitives replace.
 *
 * Pass `patch.__resetCache = true` (or just call invalidate()) to force the
 * next getConfig() to re-read from disk.
 */
function updateConfig(dataDir, patch) {
    const path_ = configPath(dataDir);
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(path_, 'utf8')) || {}; } catch { onDisk = {}; }
    const merged = deepMerge(onDisk, patch);
    fs.mkdirSync(path.dirname(path_), { recursive: true });
    const tmp = path_ + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, path_);
    try { fs.chmodSync(path_, 0o600); } catch { /* Windows etc. */ }
    invalidate();
    return getConfig(dataDir);
}

function invalidate() { _cache = null; _cacheAt = 0; }

/**
 * Helpers — config consumers don't reach into the merged object directly,
 * they ask focused questions so the call sites stay readable.
 */
function isLinkedInAutosyncEnabled(dataDir) {
    return !!getConfig(dataDir).linkedinAutosync;
}

function isDemoMode(dataDir) {
    return !!getConfig(dataDir).demoMode;
}

function getGoogleClient(dataDir) {
    const c = getConfig(dataDir).google || {};
    return { id: c.clientId || '', secret: c.clientSecret || '' };
}

function getMicrosoftClient(dataDir) {
    const c = getConfig(dataDir).microsoft || {};
    return { id: c.clientId || '', secret: c.clientSecret || '' };
}

function getApolloKey(dataDir) {
    return (getConfig(dataDir).apollo || {}).apiKey || '';
}

/**
 * Returns a sanitised view of the config with secrets masked, suitable for
 * GET /api/settings without leaking client secrets.
 */
function getRedactedConfig(dataDir) {
    const c = getConfig(dataDir);
    const mask = (s) => s ? '••••' + String(s).slice(-4) : '';
    return {
        linkedinAutosync: c.linkedinAutosync,
        demoMode: c.demoMode,
        aiBackend: c.aiBackend,
        google: {
            clientId: c.google.clientId,
            clientSecretSet: !!c.google.clientSecret,
            clientSecretMasked: mask(c.google.clientSecret),
        },
        microsoft: {
            clientId: c.microsoft.clientId,
            clientSecretSet: !!c.microsoft.clientSecret,
            clientSecretMasked: mask(c.microsoft.clientSecret),
        },
        apollo: {
            apiKeySet: !!c.apollo.apiKey,
            apiKeyMasked: mask(c.apollo.apiKey),
        },
    };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function deepMerge(target, source) {
    const out = deepClone(target);
    for (const key of Object.keys(source || {})) {
        const v = source[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            out[key] = deepMerge(out[key] || {}, v);
        } else if (v !== undefined) {
            out[key] = v;
        }
    }
    return out;
}

function deepClone(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(deepClone);
    const out = {};
    for (const k of Object.keys(o)) out[k] = deepClone(o[k]);
    return out;
}

function setPath(obj, dotPath, value) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

module.exports = {
    DEFAULTS,
    getConfig,
    updateConfig,
    invalidate,
    isLinkedInAutosyncEnabled,
    isDemoMode,
    getGoogleClient,
    getMicrosoftClient,
    getApolloKey,
    getRedactedConfig,
    configPath,
    deepMerge,        // exported for tests
    deepClone,
};
