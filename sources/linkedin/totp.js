/**
 * RFC 6238 TOTP generator. Pure Node built-ins (crypto) — no new deps.
 *
 * The TOTP secret is the base32 string you get when LinkedIn (or any TOTP
 * provider) shows you a QR code during 2FA setup. It's what most authenticator
 * apps scan. If you can see your 6-digit code in Google Authenticator / Authy
 * / 1Password, there's a base32 secret behind it — that's what goes here.
 *
 * Note: LinkedIn's default 2FA is SMS, not TOTP. To get a TOTP secret, you
 * need to set up "Authenticator app" 2FA in LinkedIn → Settings → Sign in &
 * security → Two-step verification → Authenticator app. Save the base32 key
 * LinkedIn shows BEFORE scanning the QR — that's the `totpSecret` we need.
 */

'use strict';

const crypto = require('crypto');

// Decode RFC 4648 base32 (A-Z, 2-7) to a Buffer. Pads ignored/optional.
function decodeBase32(secret) {
    if (typeof secret !== 'string') throw new TypeError('secret must be a string');
    const cleaned = secret.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
    if (!/^[A-Z2-7]+$/.test(cleaned)) throw new Error('secret contains invalid base32 characters');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of cleaned) {
        const v = alphabet.indexOf(ch);
        bits += v.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

/**
 * Generate a 6-digit TOTP code for the given base32 secret.
 * Uses 30-second time step (TOTP default), SHA-1 (TOTP default, NOT for
 * security strength — this is the spec).
 *
 * @param {string} secret - base32 shared secret (as shown during 2FA setup)
 * @param {number} [nowMs=Date.now()] - override for testing
 * @returns {string} 6-digit code, zero-padded
 */
function totp(secret, nowMs = Date.now()) {
    const key = decodeBase32(secret);
    const counter = Math.floor(nowMs / 1000 / 30);
    // 8-byte big-endian counter
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(counter));
    const h = crypto.createHmac('sha1', key).update(counterBuf).digest();
    // Dynamic truncation (RFC 4226 §5.3)
    const offset = h[h.length - 1] & 0x0f;
    const code = (
        ((h[offset]     & 0x7f) << 24) |
        ((h[offset + 1] & 0xff) << 16) |
        ((h[offset + 2] & 0xff) << 8)  |
         (h[offset + 3] & 0xff)
    ) % 1000000;
    return code.toString().padStart(6, '0');
}

/**
 * Seconds remaining in the current 30-second window before the code changes.
 * Useful when you don't want to enter a code that's about to expire.
 */
function secondsUntilNext(nowMs = Date.now()) {
    return 30 - Math.floor((nowMs / 1000) % 30);
}

module.exports = { totp, secondsUntilNext, decodeBase32 };
