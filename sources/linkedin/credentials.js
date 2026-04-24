/**
 * sources/linkedin/credentials.js — local-only LinkedIn credential store.
 *
 * Stores `{email, password, totpSecret}` at `data/linkedin/credentials.json`
 * with 0o600 permissions. Refuses to READ the file if permissions have
 * loosened — matches the pattern used for the Playwright profile dir.
 *
 * ⚠ This IS plaintext on disk. Minty's threat model for auto-login assumes:
 *    - Single-user machine (no untrusted accounts)
 *    - Disk encryption at the OS level (FileVault / LUKS / BitLocker)
 *    - You accept that "malware running as your user" can read this file
 *
 * If those assumptions don't hold, don't enable auto-login — use the headful
 * `linkedin:connect` flow which stores only a session cookie (still readable
 * by same-user malware, but shorter-lived and lower-value).
 *
 * No keychain / OS-secret-store integration in this cut — that's a cross-
 * platform yak (keytar native build, platform branches, test story) that was
 * explicitly deferred in the design doc. File follow-ups on the roadmap if
 * this matters to you.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join('data', 'linkedin', 'credentials.json');

function credPath(dataDir) {
    return path.join(dataDir || 'data', 'linkedin', 'credentials.json');
}

function ensureSecure(filePath) {
    // POSIX-only. Windows NTFS doesn't honor 0o600 the way Unix does — mode
    // bits end up reporting 0o666 regardless of chmodSync. Rely on the
    // user-profile directory ACLs on Windows; the check would false-positive
    // here otherwise. (Same pattern as the browser-profile dir perm check.)
    if (process.platform === 'win32') return;
    const st = fs.statSync(filePath);
    if ((st.mode & 0o077) !== 0) {
        const err = new Error(
            `credentials.json permissions too loose (mode=${(st.mode & 0o777).toString(8)}). ` +
            `Run: chmod 600 ${filePath}`
        );
        err.code = 'INSECURE_PERMS';
        throw err;
    }
}

function validate(creds) {
    if (!creds || typeof creds !== 'object') throw new Error('credentials must be an object');
    for (const k of ['email', 'password']) {
        if (typeof creds[k] !== 'string' || creds[k].length === 0) {
            throw new Error(`credentials.${k} is required`);
        }
    }
    // totpSecret is optional — if present must be a string (further base32
    // validation deferred to totp.js which throws on invalid characters)
    if (creds.totpSecret !== undefined && typeof creds.totpSecret !== 'string') {
        throw new Error('credentials.totpSecret must be a string if provided');
    }
}

/** Returns parsed credentials, or null if file doesn't exist. Throws if perms loose. */
function read(dataDir) {
    const p = credPath(dataDir);
    if (!fs.existsSync(p)) return null;
    ensureSecure(p);
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        validate(parsed);
        return parsed;
    } catch (err) {
        if (err.code === 'INSECURE_PERMS') throw err;
        const e = new Error(`credentials.json is malformed: ${err.message}`);
        e.cause = err;
        throw e;
    }
}

/** Atomic write with 0o600 on the result. */
function write(dataDir, creds) {
    validate(creds);
    const p = credPath(dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, JSON.stringify({
            email: creds.email,
            password: creds.password,
            ...(creds.totpSecret ? { totpSecret: creds.totpSecret } : {}),
        }, null, 2));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, p);
    // Belt-and-suspenders: chmod after rename too (covers odd umask cases)
    try { fs.chmodSync(p, 0o600); } catch {}
}

function remove(dataDir) {
    const p = credPath(dataDir);
    if (fs.existsSync(p)) fs.unlinkSync(p);
}

function exists(dataDir) {
    return fs.existsSync(credPath(dataDir));
}

module.exports = {
    read, write, remove, exists,
    credPath, ensureSecure, validate,
    DEFAULT_PATH,
};
