/**
 * crm/config.js — runtime user config with hot-reload.
 *
 * Self-hosted users shouldn't have to touch env vars to enable features.
 * Settings UI writes to data/config.json; this module reads it on every
 * access, falling back to env vars for backwards-compatibility.
 *
 * Resolution order per key (highest priority wins):
 *   1. ENV var (e.g. MINTY_LINKEDIN_AUTOSYNC=1, GOOGLE_CLIENT_ID=…)
 *   2. data/config.json
 *   3. data/minty-mode.json (legacy — still supported for the demo flag)
 *   4. built-in default
 *
 * Hot-reload: getConfig() always reads current state without a restart.
 * Cached in-process for ~1s to keep request paths fast.
 *
 * 0600 permissions on save because config.json can hold OAuth client secrets.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
    // On by default — toggling on alone doesn't initiate any scraping;
    // the user still has to click "Connect to LinkedIn" to log in once.
    // Setting this to true just means the 24h periodic tick is wired up
    // and ready to fire after a successful connect, without making the
    // user dig through Settings to flip it on first.
    linkedinAutosync: true,
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
});

const ENV_OVERRIDES = {
    'linkedinAutosync':       () => process.env.MINTY_LINKEDIN_AUTOSYNC === '1' ? true : null,
    'demoMode':               () => process.env.MINTY_DEMO === '1' ? true : null,
    'google.clientId':        () => process.env.GOOGLE_CLIENT_ID || null,
    'google.clientSecret':    () => process.env.GOOGLE_CLIENT_SECRET || null,
    'microsoft.clientId':     () => process.env.MICROSOFT_CLIENT_ID || null,
    'microsoft.clientSecret': () => process.env.MICROSOFT_CLIENT_SECRET || null,
    'apollo.apiKey':          () => process.env.APOLLO_API_KEY || null,
};

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 1000;

function configPath(dataDir) {
    return path.join(dataDir, 'config.json');
}

function legacyModePath(dataDir) {
    return path.join(dataDir, 'minty-mode.json');
}

function getConfig(dataDir) {
    const now = Date.now();
    if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;

    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8')) || {}; } catch { /* missing */ }

    const legacy = {};
    try {
        const m = JSON.parse(fs.readFileSync(legacyModePath(dataDir), 'utf8')) || {};
        if (m.mode === 'demo') legacy.demoMode = true;
    } catch { /* missing legacy file is fine */ }

    let merged = deepMerge(deepMerge(deepClone(DEFAULTS), legacy), onDisk);

    for (const [dotPath, getter] of Object.entries(ENV_OVERRIDES)) {
        const v = getter();
        if (v !== null && v !== undefined) setPath(merged, dotPath, v);
    }

    _cache = Object.freeze(deepFreeze(deepClone(merged)));
    _cacheAt = now;
    return _cache;
}

function updateConfig(dataDir, patch) {
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8')) || {}; } catch { /* missing */ }
    const merged = deepMerge(onDisk, patch);
    fs.mkdirSync(path.dirname(configPath(dataDir)), { recursive: true });
    const tmp = configPath(dataDir) + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, configPath(dataDir));
    try { fs.chmodSync(configPath(dataDir), 0o600); } catch { /* Windows etc. */ }
    invalidate();
    return getConfig(dataDir);
}

function invalidate() { _cache = null; _cacheAt = 0; }

function isLinkedInAutosyncEnabled(dataDir) { return !!getConfig(dataDir).linkedinAutosync; }
function isDemoMode(dataDir)               { return !!getConfig(dataDir).demoMode; }

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

// Returns true when an env var is forcing this key — UI uses this to show
// "set via env, can't toggle from UI" hints instead of fighting the env.
function envForces(key) {
    const getter = ENV_OVERRIDES[key];
    if (!getter) return false;
    const v = getter();
    return v !== null && v !== undefined;
}

/**
 * Sanitised view safe for GET /api/settings — masks any client secret.
 */
function getRedactedConfig(dataDir) {
    const c = getConfig(dataDir);
    const mask = (s) => s ? '••••' + String(s).slice(-4) : '';
    return {
        linkedinAutosync: c.linkedinAutosync,
        demoMode: c.demoMode,
        envForces: {
            linkedinAutosync: envForces('linkedinAutosync'),
            demoMode: envForces('demoMode'),
            google: {
                clientId: envForces('google.clientId'),
                clientSecret: envForces('google.clientSecret'),
            },
            microsoft: {
                clientId: envForces('microsoft.clientId'),
                clientSecret: envForces('microsoft.clientSecret'),
            },
            apollo: { apiKey: envForces('apollo.apiKey') },
        },
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

function deepFreeze(o) {
    if (o === null || typeof o !== 'object') return o;
    Object.values(o).forEach(deepFreeze);
    return Object.freeze(o);
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
    getConfig,
    updateConfig,
    invalidate,
    getRedactedConfig,
    isLinkedInAutosyncEnabled,
    isDemoMode,
    getGoogleClient,
    getMicrosoftClient,
    getApolloKey,
    envForces,
    // pure helpers — exported for tests
    deepMerge,
    deepClone,
    setPath,
};
