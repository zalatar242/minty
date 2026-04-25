/**
 * tests/unit/linkedin-totp.test.js — tests for sources/linkedin/totp.js
 *
 * Primary validation: RFC 6238 canonical test vectors. If our implementation
 * matches the RFC at specific timestamps, we can generate valid TOTP codes
 * for real TOTP providers (LinkedIn, Google, etc).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { totp, decodeBase32, secondsUntilNext } = require('../../sources/linkedin/totp');

test('[totp] decodeBase32: valid ASCII input round-trips', () => {
    // "12345678901234567890" → base32 encoding of ASCII digits
    const b32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const decoded = decodeBase32(b32);
    assert.equal(decoded.toString('ascii'), '12345678901234567890');
});

test('[totp] decodeBase32: lowercase and whitespace tolerated (consistency)', () => {
    // We don't pin the decoded bytes here — base32 has a canonical output;
    // just verify lowercase + whitespace produce the same bytes as upper-case.
    const upper = decodeBase32('JBSWY3DPEHPK3PXP').toString('hex');
    const lowerWs = decodeBase32('jbswy 3dpe hpk3 pxp').toString('hex');
    assert.equal(lowerWs, upper);
    assert.ok(upper.length > 0, 'decoded bytes should be non-empty');
});

test('[totp] decodeBase32: padding stripped', () => {
    assert.equal(decodeBase32('JBSWY3DP====').toString('ascii'), 'Hello');
});

test('[totp] decodeBase32: rejects non-base32 chars', () => {
    assert.throws(() => decodeBase32('!!!'), /invalid base32/);
    assert.throws(() => decodeBase32('JBSWY1DPEH'), /invalid base32/); // '1' not in alphabet
});

test('[totp] decodeBase32: rejects non-string input', () => {
    assert.throws(() => decodeBase32(null), TypeError);
    assert.throws(() => decodeBase32(123), TypeError);
});

// RFC 6238 canonical test vectors. Secret "12345678901234567890" base32
// = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ". RFC gives 8-digit codes at
// specific Unix times; we generate 6-digit, so we compare the last 6.
test('[totp] RFC 6238 vector T=59 → 94287082 (6-digit: 287082)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totp(secret, 59 * 1000), '287082');
});

test('[totp] RFC 6238 vector T=1111111109 → 07081804 (6-digit: 081804)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totp(secret, 1111111109 * 1000), '081804');
});

test('[totp] RFC 6238 vector T=1111111111 → 14050471 (6-digit: 050471)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totp(secret, 1111111111 * 1000), '050471');
});

test('[totp] RFC 6238 vector T=1234567890 → 89005924 (6-digit: 005924)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totp(secret, 1234567890 * 1000), '005924');
});

test('[totp] RFC 6238 vector T=2000000000 → 69279037 (6-digit: 279037)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totp(secret, 2000000000 * 1000), '279037');
});

test('[totp] code changes across the 30s boundary', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const t1 = totp(secret, 30 * 1000);           // window starting at t=30
    const t2 = totp(secret, 30 * 1000 + 29999);   // still same window
    const t3 = totp(secret, 60 * 1000);           // new window
    assert.equal(t1, t2);
    assert.notEqual(t1, t3);
});

test('[totp] code is always 6 digits zero-padded', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    for (let t = 0; t < 300 * 1000; t += 30 * 1000) {
        const code = totp(secret, t);
        assert.match(code, /^\d{6}$/);
    }
});

test('[totp] secondsUntilNext: 30 at window start, 1 just before rollover', () => {
    assert.equal(secondsUntilNext(30 * 1000), 30);
    assert.equal(secondsUntilNext(30 * 1000 + 29 * 1000), 1);
    assert.equal(secondsUntilNext(60 * 1000), 30); // next window start
});
