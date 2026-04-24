/**
 * crm/export.js — bundle the unified CRM state into a single portable file.
 *
 * Shape of the bundle:
 *   {
 *     version: 1,
 *     exportedAt: ISO,
 *     contacts:       [...],   // data/unified/contacts.json
 *     interactions:   [...],   // data/unified/interactions.json
 *     insights:       {...},   // optional
 *     goals:          [...],   // optional
 *     groupMemberships: {...}, // optional
 *     syncState:      {...},   // optional — shows last successful syncs
 *     insightsAt:     ISO | null,
 *   }
 *
 * Two output modes:
 *   - plain JSON                    (default)
 *   - AES-256-GCM encrypted         (opt-in via passphrase)
 *
 * The module exports pure(ish) helpers so the server and the CLI share logic.
 * File I/O is confined to `readBundle(dataDir)` and `writeBundle(path, buf)`;
 * everything else is a pure function.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KDF_ITERS = 200000;

/**
 * Read every unified JSON file from `dataDir` into a bundle object.
 * Missing optional files are simply omitted.
 */
function readBundle(dataDir) {
    const unified = path.join(dataDir, 'unified');
    const load = (name) => {
        try { return JSON.parse(fs.readFileSync(path.join(unified, name), 'utf8')); }
        catch { return null; }
    };
    const loadMtime = (name) => {
        try { return new Date(fs.statSync(path.join(unified, name)).mtimeMs).toISOString(); }
        catch { return null; }
    };

    const bundle = {
        version: 1,
        exportedAt: new Date().toISOString(),
        contacts:         load('contacts.json')         || [],
        interactions:     load('interactions.json')     || [],
        insights:         load('insights.json')         || null,
        goals:            load('goals.json')            || null,
        groupMemberships: load('group-memberships.json') || null,
        queryIndex:       load('query-index.json')      || null,
        digest:           load('digest.json')           || null,
        syncState:        tryLoad(path.join(dataDir, 'sync-state.json')),
        insightsAt:       loadMtime('insights.json'),
        stats: {},
    };
    bundle.stats = {
        contacts:     Array.isArray(bundle.contacts) ? bundle.contacts.length : 0,
        interactions: Array.isArray(bundle.interactions) ? bundle.interactions.length : 0,
        insights:     bundle.insights ? Object.keys(bundle.insights).length : 0,
        goals:        Array.isArray(bundle.goals) ? bundle.goals.length : 0,
    };
    return bundle;
}

function tryLoad(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return null; }
}

/**
 * Serialise a bundle to a Buffer. Always gzip-compressed; optionally
 * AES-256-GCM encrypted with a passphrase-derived key.
 *
 * Encrypted layout (Buffer):
 *   [4 bytes magic 'MCR1'] [salt 16] [iv 12] [tag 16] [ciphertext…]
 *
 * The plaintext before encryption is gzip-compressed JSON.
 */
function serialise(bundle, opts = {}) {
    const json = Buffer.from(JSON.stringify(bundle));
    const compressed = zlib.gzipSync(json);

    if (!opts.passphrase) {
        return { buffer: compressed, encrypted: false };
    }

    const salt = crypto.randomBytes(SALT_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);
    const key = crypto.pbkdf2Sync(String(opts.passphrase), salt, KDF_ITERS, 32, 'sha256');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    const header = Buffer.from('MCR1');
    return {
        buffer: Buffer.concat([header, salt, iv, tag, ct]),
        encrypted: true,
    };
}

/**
 * Inverse of serialise. Returns the parsed bundle object.
 */
function deserialise(buffer, opts = {}) {
    if (!Buffer.isBuffer(buffer)) throw new Error('deserialise needs a Buffer');

    // Detect encryption via magic header
    const header = buffer.slice(0, 4).toString('utf8');
    if (header === 'MCR1') {
        if (!opts.passphrase) throw new Error('Encrypted bundle — passphrase required');
        const salt = buffer.slice(4, 4 + SALT_BYTES);
        const iv = buffer.slice(4 + SALT_BYTES, 4 + SALT_BYTES + IV_BYTES);
        const tag = buffer.slice(4 + SALT_BYTES + IV_BYTES, 4 + SALT_BYTES + IV_BYTES + TAG_BYTES);
        const ct = buffer.slice(4 + SALT_BYTES + IV_BYTES + TAG_BYTES);
        const key = crypto.pbkdf2Sync(String(opts.passphrase), salt, KDF_ITERS, 32, 'sha256');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const compressed = Buffer.concat([decipher.update(ct), decipher.final()]);
        return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    }

    // Plain gzipped JSON
    const compressed = buffer;
    return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
}

/**
 * Convenience: run a full export end-to-end and return { buffer, filename, stats }.
 * Filename includes timestamp + encryption suffix.
 */
function exportAll(dataDir, opts = {}) {
    const bundle = readBundle(dataDir);
    const { buffer, encrypted } = serialise(bundle, opts);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const suffix = encrypted ? 'minty.bundle' : 'minty.bundle.gz';
    const filename = `minty-${ts}.${suffix}`;
    return { buffer, filename, stats: bundle.stats, encrypted };
}

module.exports = {
    readBundle,
    serialise,
    deserialise,
    exportAll,
};
