'use strict';

// ---------------------------------------------------------------------------
// LinkedIn session-expiry / challenge URL detection.
//
// Plain regex-based classifier. When `fetch.js` navigates and ends up at one
// of these URLs, the persisted session cookie is no longer usable: either
// LinkedIn logged the user out entirely ("expired") or is demanding an
// interactive challenge ("challenge"). Either way, background sync must stop
// and the user must re-run `npm run linkedin:connect`.
//
// See design M2 / M-6: "Session-expiry URL detection untested. Add a fixture
// test for isSessionExpired(url) with real LinkedIn redirect URLs (login,
// checkpoint, challenge variants with query strings)."
// ---------------------------------------------------------------------------

// Paths that unambiguously mean "session is gone, must log in again".
// Matched by path prefix on the LinkedIn host. Query strings ignored.
const EXPIRED_PATH_PREFIXES = [
    '/login',
    '/authwall',
    '/uas/login',
    '/uas/consumer-login',
    '/checkpoint/lg/',
    '/checkpoint/challenge/',
    '/checkpoint/rm/',
];

// Paths that indicate an interactive reauth / device challenge. A superset
// lives inside EXPIRED_PATH_PREFIXES (the /checkpoint/* ones); this list is
// used only by isChallenge() to distinguish "just re-login" from "LinkedIn
// wants an interactive challenge response".
const CHALLENGE_PATH_PREFIXES = [
    '/checkpoint/',
    '/challenge/',
];

// Query-param keys on `linkedin.com/` root that mean "LinkedIn bounced the
// user to login and is about to redirect to the login wall". Seen in real
// redirect chains, e.g. https://www.linkedin.com/?trk=login_reg_redirect
const ROOT_LOGIN_TRK_VALUES = new Set([
    'login_reg_redirect',
    'guest_homepage-basic_nav-header-signin',
]);

const LINKEDIN_HOST_RE = /(^|\.)linkedin\.com$/i;

/**
 * Normalize an input (URL string, URL object, or bare path) into
 * `{ host, pathname, search }` — or `null` if the input can't be understood.
 * Never throws.
 */
function parseUrl(input) {
    if (input == null) return null;
    // URL instance.
    if (typeof input === 'object' && typeof input.pathname === 'string') {
        return {
            host: (input.host || input.hostname || '').toLowerCase(),
            pathname: input.pathname || '/',
            search: input.search || '',
        };
    }
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (trimmed === '') return null;

    // Bare path input like "/login" or "/login?foo=bar".
    if (trimmed.startsWith('/')) {
        const q = trimmed.indexOf('?');
        return {
            host: '',
            pathname: q === -1 ? trimmed : trimmed.slice(0, q),
            search: q === -1 ? '' : trimmed.slice(q),
        };
    }

    // Try as full URL. Add scheme if missing so URL() doesn't throw on
    // "www.linkedin.com/login".
    let candidate = trimmed;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
        candidate = 'https://' + candidate;
    }
    try {
        const u = new URL(candidate);
        return {
            host: u.host.toLowerCase(),
            pathname: u.pathname || '/',
            search: u.search || '',
        };
    } catch (_err) {
        return null;
    }
}

function isLinkedInHost(host) {
    if (!host) return false;
    // Strip port if any.
    const h = host.split(':')[0];
    return LINKEDIN_HOST_RE.test(h);
}

function pathStartsWithAny(pathname, prefixes) {
    if (!pathname) return false;
    for (const p of prefixes) {
        if (pathname === p || pathname.startsWith(p)) return true;
        // For prefixes that end with '/', also match the trailing-slash-less
        // form: '/checkpoint/lg/' should match '/checkpoint/lg'.
        if (p.endsWith('/') && pathname === p.slice(0, -1)) return true;
    }
    return false;
}

/**
 * True when LinkedIn redirected us to login / authwall / checkpoint — any
 * page that means the persisted session is no longer authenticated.
 */
function isSessionExpired(input) {
    const parsed = parseUrl(input);
    if (!parsed) return false;

    // For path-only inputs, host is ''. Accept those — the caller is telling
    // us "this is a LinkedIn path".
    const isLinkedIn = parsed.host === '' || isLinkedInHost(parsed.host);
    if (!isLinkedIn) return false;

    if (pathStartsWithAny(parsed.pathname, EXPIRED_PATH_PREFIXES)) return true;

    // Root bounce: linkedin.com/?trk=login_reg_redirect (and similar).
    if (parsed.pathname === '/' || parsed.pathname === '') {
        if (parsed.search) {
            const params = new URLSearchParams(parsed.search);
            const trk = params.get('trk');
            if (trk && ROOT_LOGIN_TRK_VALUES.has(trk)) return true;
        }
    }

    return false;
}

/**
 * True when the URL specifically looks like a LinkedIn reauth / device
 * challenge (checkpoint/* or challenge/*). Subset of isSessionExpired for
 * most URLs, but /challenge/ alone is a challenge-only signal.
 */
function isChallenge(input) {
    const parsed = parseUrl(input);
    if (!parsed) return false;
    const isLinkedIn = parsed.host === '' || isLinkedInHost(parsed.host);
    if (!isLinkedIn) return false;
    return pathStartsWithAny(parsed.pathname, CHALLENGE_PATH_PREFIXES);
}

/**
 * Classifier that returns one of:
 *   "ok"        — known-good LinkedIn URL (feed, in/..., messaging, etc.)
 *   "challenge" — reauth/device challenge, user action required
 *   "expired"   — logged out, session gone, user must re-run connect
 *   "unknown"   — could not parse, not LinkedIn, or neutral URL we don't
 *                 recognize. Callers should treat this as "don't change
 *                 status" rather than as a failure signal.
 */
function classifyUrl(input) {
    const parsed = parseUrl(input);
    if (!parsed) return 'unknown';

    const isLinkedIn = parsed.host === '' || isLinkedInHost(parsed.host);
    if (!isLinkedIn) return 'unknown';

    // Challenge wins over expired: a /checkpoint/challenge/ URL is both but
    // we want callers to see the more specific signal.
    if (isChallenge(parsed)) return 'challenge';
    if (isSessionExpired(parsed)) return 'expired';

    return 'ok';
}

module.exports = {
    isSessionExpired,
    isChallenge,
    classifyUrl,
};
