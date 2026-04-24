'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    isSessionExpired,
    isChallenge,
    classifyUrl,
} = require('../../sources/linkedin/session-detect');

// ---------------------------------------------------------------------------
// Happy paths — these are authenticated pages. None should look expired.
// ---------------------------------------------------------------------------

test('happy path: /feed is not expired', () => {
    const url = 'https://www.linkedin.com/feed/';
    assert.equal(isSessionExpired(url), false);
    assert.equal(isChallenge(url), false);
    assert.equal(classifyUrl(url), 'ok');
});

test('happy path: /mynetwork/invite-connect/connections/ is not expired', () => {
    const url = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
    assert.equal(isSessionExpired(url), false);
    assert.equal(classifyUrl(url), 'ok');
});

test('happy path: /messaging/thread/<id>/ is not expired', () => {
    const url = 'https://www.linkedin.com/messaging/thread/2-abc123/';
    assert.equal(isSessionExpired(url), false);
    assert.equal(classifyUrl(url), 'ok');
});

test('happy path: /in/<slug>/ profile is not expired', () => {
    const url = 'https://www.linkedin.com/in/someone-cool-12345/';
    assert.equal(isSessionExpired(url), false);
    assert.equal(classifyUrl(url), 'ok');
});

test('happy path: /company/<slug>/ is not expired', () => {
    const url = 'https://www.linkedin.com/company/anthropic/';
    assert.equal(isSessionExpired(url), false);
    assert.equal(classifyUrl(url), 'ok');
});

// ---------------------------------------------------------------------------
// Expired URL variants.
// ---------------------------------------------------------------------------

const EXPIRED_URLS = [
    'https://www.linkedin.com/login',
    'https://www.linkedin.com/login/',
    'https://www.linkedin.com/authwall',
    'https://www.linkedin.com/authwall?trk=ripple',
    'https://www.linkedin.com/uas/login',
    'https://www.linkedin.com/uas/login?session_redirect=%2Ffeed',
    'https://www.linkedin.com/uas/consumer-login',
    'https://www.linkedin.com/checkpoint/lg/login-submit',
    'https://www.linkedin.com/checkpoint/rm/sign-in-another-account',
];

for (const url of EXPIRED_URLS) {
    test(`expired: ${url}`, () => {
        assert.equal(isSessionExpired(url), true, url + ' should be expired');
        assert.notEqual(classifyUrl(url), 'ok');
        assert.notEqual(classifyUrl(url), 'unknown');
    });
}

// ---------------------------------------------------------------------------
// Challenge URL variants — all checkpoint/* except /checkpoint/lg/* and
// /checkpoint/rm/* still register as challenges (they're all under the
// checkpoint umbrella); classifyUrl resolves to "challenge" in those cases.
// ---------------------------------------------------------------------------

const CHALLENGE_URLS = [
    'https://www.linkedin.com/checkpoint/challenge/verify',
    'https://www.linkedin.com/checkpoint/challenge/AgEAbc123',
    'https://www.linkedin.com/checkpoint/lg/login-submit',
    'https://www.linkedin.com/checkpoint/rm/sign-in-another-account',
    'https://www.linkedin.com/challenge/AgEsomething',
];

for (const url of CHALLENGE_URLS) {
    test(`challenge: ${url}`, () => {
        assert.equal(isChallenge(url), true, url + ' should be challenge');
        assert.equal(classifyUrl(url), 'challenge');
    });
}

// ---------------------------------------------------------------------------
// Query strings must not defeat detection.
// ---------------------------------------------------------------------------

test('query strings do not defeat /login detection', () => {
    assert.equal(
        isSessionExpired('https://www.linkedin.com/login?session_redirect=%2Ffeed%2F&fromSignIn=1'),
        true,
    );
});

test('query strings do not defeat /checkpoint detection', () => {
    assert.equal(
        isSessionExpired('https://www.linkedin.com/checkpoint/challenge/verify?ct=1234567890&trk=anywhere'),
        true,
    );
    assert.equal(
        isChallenge('https://www.linkedin.com/checkpoint/challenge/verify?ct=1234567890'),
        true,
    );
});

test('linkedin.com/ with ?trk=login_reg_redirect counts as expired', () => {
    const url = 'https://www.linkedin.com/?trk=login_reg_redirect';
    assert.equal(isSessionExpired(url), true);
    assert.equal(classifyUrl(url), 'expired');
});

test('linkedin.com/ with ?trk=guest_homepage-basic_nav-header-signin counts as expired', () => {
    const url = 'https://www.linkedin.com/?trk=guest_homepage-basic_nav-header-signin';
    assert.equal(isSessionExpired(url), true);
});

test('linkedin.com/ with unrelated ?trk is NOT expired', () => {
    // Neutral homepage visit with some unrelated tracking param — don't
    // fire a false positive.
    const url = 'https://www.linkedin.com/?trk=public_profile_nav';
    assert.equal(isSessionExpired(url), false);
    assert.equal(classifyUrl(url), 'ok');
});

// ---------------------------------------------------------------------------
// Locale-ish query params.
// ---------------------------------------------------------------------------

test('locale query param on /uas/login still expired', () => {
    assert.equal(
        isSessionExpired('https://www.linkedin.com/uas/login?lang=en'),
        true,
    );
    assert.equal(
        isSessionExpired('https://www.linkedin.com/uas/login?lang=fr_FR&session_redirect=%2Ffeed'),
        true,
    );
});

// ---------------------------------------------------------------------------
// Host variants.
// ---------------------------------------------------------------------------

test('www.linkedin.com host works', () => {
    assert.equal(isSessionExpired('https://www.linkedin.com/login'), true);
});

test('linkedin.com (no www) host works', () => {
    assert.equal(isSessionExpired('https://linkedin.com/login'), true);
    assert.equal(classifyUrl('https://linkedin.com/checkpoint/challenge/x'), 'challenge');
});

test('mobile subdomain m.linkedin.com/login counts as expired', () => {
    assert.equal(isSessionExpired('https://m.linkedin.com/login'), true);
    assert.equal(isSessionExpired('https://m.linkedin.com/checkpoint/challenge/verify'), true);
    assert.equal(classifyUrl('https://m.linkedin.com/checkpoint/challenge/verify'), 'challenge');
});

test('hostless input without scheme (www.linkedin.com/login) works', () => {
    assert.equal(isSessionExpired('www.linkedin.com/login'), true);
});

// ---------------------------------------------------------------------------
// Non-LinkedIn URLs.
// ---------------------------------------------------------------------------
//
// Ambiguity resolution: the task description says "e.g., the login page
// redirects to https://www.linkedin.com then bounces elsewhere — best-effort;
// document what your code does". We treat any non-LinkedIn host as
// classifyUrl() => "unknown", isSessionExpired => false, isChallenge =>
// false. Rationale: fetch.js should only react to *LinkedIn's* signals.
// A redirect off to accounts.google.com or facebook.com is almost certainly
// a bug in the scrape flow, not a "session expired" signal, and we don't
// want to flap the UI status on unrelated URLs.

test('non-linkedin URL => classifyUrl=unknown, not expired, not challenge', () => {
    const url = 'https://example.com/login';
    assert.equal(isSessionExpired(url), false);
    assert.equal(isChallenge(url), false);
    assert.equal(classifyUrl(url), 'unknown');
});

test('google.com/accounts/login => unknown (not our problem)', () => {
    const url = 'https://accounts.google.com/signin';
    assert.equal(classifyUrl(url), 'unknown');
});

test('look-alike domain linkedin.com.evil.test does NOT match', () => {
    // Regex (^|\.)linkedin\.com$ refuses linkedin.com.evil.test because the
    // suffix isn't exactly linkedin.com.
    const url = 'https://linkedin.com.evil.test/login';
    assert.equal(isSessionExpired(url), false);
    assert.equal(classifyUrl(url), 'unknown');
});

// ---------------------------------------------------------------------------
// Null / undefined / empty / garbage input.
// ---------------------------------------------------------------------------

test('null input: no throw, classifyUrl=unknown', () => {
    assert.doesNotThrow(() => isSessionExpired(null));
    assert.doesNotThrow(() => isChallenge(null));
    assert.doesNotThrow(() => classifyUrl(null));
    assert.equal(isSessionExpired(null), false);
    assert.equal(isChallenge(null), false);
    assert.equal(classifyUrl(null), 'unknown');
});

test('undefined input: no throw, classifyUrl=unknown', () => {
    assert.equal(isSessionExpired(undefined), false);
    assert.equal(isChallenge(undefined), false);
    assert.equal(classifyUrl(undefined), 'unknown');
});

test('empty string input: no throw, classifyUrl=unknown', () => {
    assert.equal(isSessionExpired(''), false);
    assert.equal(isChallenge(''), false);
    assert.equal(classifyUrl(''), 'unknown');
});

test('whitespace-only string input: unknown', () => {
    assert.equal(classifyUrl('   '), 'unknown');
});

test('garbage string input: unknown, no throw', () => {
    assert.doesNotThrow(() => classifyUrl('not a url at all ::::'));
    // This may parse as a relative-ish thing; what matters is it doesn't
    // throw and it doesn't falsely report expired.
    assert.equal(isSessionExpired('not a url at all ::::'), false);
});

test('non-string non-URL object input: unknown, no throw', () => {
    assert.equal(classifyUrl(42), 'unknown');
    assert.equal(classifyUrl({}), 'unknown');
    assert.equal(classifyUrl([]), 'unknown');
});

// ---------------------------------------------------------------------------
// Path-only inputs.
// ---------------------------------------------------------------------------

test('path-only "/login" is expired', () => {
    assert.equal(isSessionExpired('/login'), true);
});

test('path-only "/checkpoint/challenge/verify" is challenge', () => {
    assert.equal(isChallenge('/checkpoint/challenge/verify'), true);
    assert.equal(classifyUrl('/checkpoint/challenge/verify'), 'challenge');
});

test('path-only "/feed" is ok', () => {
    assert.equal(isSessionExpired('/feed'), false);
    assert.equal(classifyUrl('/feed'), 'ok');
});

test('path-only with query string "/login?foo=bar" is expired', () => {
    assert.equal(isSessionExpired('/login?session_redirect=%2Ffeed'), true);
});

// ---------------------------------------------------------------------------
// URL-object input (playwright hands us strings today, but support parsed
// URLs for future-proofing).
// ---------------------------------------------------------------------------

test('URL object input works', () => {
    const u = new URL('https://www.linkedin.com/login?foo=bar');
    assert.equal(isSessionExpired(u), true);
    assert.equal(classifyUrl(u), 'expired');
});

test('URL object for /feed is ok', () => {
    const u = new URL('https://www.linkedin.com/feed/');
    assert.equal(classifyUrl(u), 'ok');
});

// ---------------------------------------------------------------------------
// classifyUrl priority: challenge > expired.
// ---------------------------------------------------------------------------

test('classifyUrl prefers "challenge" over "expired" for checkpoint URLs', () => {
    // /checkpoint/challenge/ matches both EXPIRED_PATH_PREFIXES and
    // CHALLENGE_PATH_PREFIXES. Contract says: more specific signal wins.
    assert.equal(
        classifyUrl('https://www.linkedin.com/checkpoint/challenge/verify'),
        'challenge',
    );
});

test('classifyUrl returns "expired" for /login (not a challenge)', () => {
    assert.equal(classifyUrl('https://www.linkedin.com/login'), 'expired');
});
