'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const X = require('../../sources/linkedin/check-export-ready');

function mkTemp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-cx-'));
}

// ---------------------------------------------------------------------------
// requestStatePath
// ---------------------------------------------------------------------------

test('[CheckExport] requestStatePath resolves <dataDir>/linkedin/.export-request.json', () => {
    const d = mkTemp();
    const p = X.requestStatePath(d);
    assert.equal(p, path.join(d, 'linkedin', '.export-request.json'));
    fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readRequestState
// ---------------------------------------------------------------------------

test('[CheckExport] readRequestState returns null when file missing', () => {
    const d = mkTemp();
    assert.equal(X.readRequestState(d), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[CheckExport] readRequestState returns null when JSON is corrupt', () => {
    const d = mkTemp();
    const p = X.requestStatePath(d);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not valid json');
    assert.equal(X.readRequestState(d), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[CheckExport] readRequestState returns parsed object when valid', () => {
    const d = mkTemp();
    const p = X.requestStatePath(d);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const state = {
        status: 'pending',
        requestedAt: '2026-04-20T00:00:00.000Z',
        lastCheckedAt: '2026-04-21T00:00:00.000Z',
    };
    fs.writeFileSync(p, JSON.stringify(state));
    const got = X.readRequestState(d);
    assert.deepEqual(got, state);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[CheckExport] readRequestState returns null when JSON is a non-object (e.g. string)', () => {
    const d = mkTemp();
    const p = X.requestStatePath(d);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify('just-a-string'));
    assert.equal(X.readRequestState(d), null);
    fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeRequestState
// ---------------------------------------------------------------------------

test('[CheckExport] writeRequestState round-trips through readRequestState', () => {
    const d = mkTemp();
    const state = {
        status: 'pending',
        requestedAt: '2026-04-24T12:34:56.000Z',
        lastCheckedAt: '2026-04-24T20:00:00.000Z',
        archivePath: '/some/path/archive.zip',
    };
    X.writeRequestState(d, state);
    const got = X.readRequestState(d);
    assert.deepEqual(got, state);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[CheckExport] writeRequestState creates the linkedin/ subdirectory if missing', () => {
    const d = mkTemp();
    // intentionally do not pre-create d/linkedin/
    X.writeRequestState(d, { status: 'pending', requestedAt: new Date().toISOString() });
    assert.ok(fs.existsSync(path.join(d, 'linkedin')));
    assert.ok(fs.existsSync(path.join(d, 'linkedin', '.export-request.json')));
    fs.rmSync(d, { recursive: true, force: true });
});

test('[CheckExport] writeRequestState sets 0600 perms on POSIX', { skip: process.platform === 'win32' }, () => {
    const d = mkTemp();
    X.writeRequestState(d, { status: 'pending', requestedAt: new Date().toISOString() });
    const stat = fs.statSync(X.requestStatePath(d));
    // mask off file-type bits, keep the permission bits
    const perms = stat.mode & 0o777;
    assert.equal(perms, 0o600, `expected 0600, got 0${perms.toString(8)}`);
    fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// shouldPoll
// ---------------------------------------------------------------------------

test('[CheckExport] shouldPoll returns false for null state', () => {
    assert.equal(X.shouldPoll(null), false);
});

test('[CheckExport] shouldPoll returns false when status !== "pending"', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    assert.equal(X.shouldPoll({ status: 'completed', requestedAt: oneDayAgo }, now), false);
    assert.equal(X.shouldPoll({ status: 'auth-required', requestedAt: oneDayAgo }, now), false);
    assert.equal(X.shouldPoll({ status: '', requestedAt: oneDayAgo }, now), false);
});

test('[CheckExport] shouldPoll returns false when requestedAt is missing', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    assert.equal(X.shouldPoll({ status: 'pending' }, now), false);
});

test('[CheckExport] shouldPoll returns false for invalid requestedAt string', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    assert.equal(X.shouldPoll({ status: 'pending', requestedAt: 'not-a-date' }, now), false);
    assert.equal(X.shouldPoll({ status: 'pending', requestedAt: 'banana' }, now), false);
});

test('[CheckExport] shouldPoll returns false when requestedAt > 7 days old (regardless of lastCheckedAt)', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    // No lastCheckedAt
    assert.equal(X.shouldPoll({ status: 'pending', requestedAt: eightDaysAgo }, now), false);
    // With a recent lastCheckedAt — still false
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    assert.equal(X.shouldPoll({
        status: 'pending',
        requestedAt: eightDaysAgo,
        lastCheckedAt: oneHourAgo,
    }, now), false);
    // With an old lastCheckedAt — still false because requestedAt itself is too old
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(X.shouldPoll({
        status: 'pending',
        requestedAt: eightDaysAgo,
        lastCheckedAt: twoDaysAgo,
    }, now), false);
});

test('[CheckExport] shouldPoll returns true when requestedAt is recent + no lastCheckedAt', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    assert.equal(X.shouldPoll({ status: 'pending', requestedAt: oneDayAgo }, now), true);
});

test('[CheckExport] shouldPoll returns false when lastCheckedAt < 23h ago', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    // 1 hour ago — well under 23h
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    assert.equal(X.shouldPoll({
        status: 'pending',
        requestedAt: oneDayAgo,
        lastCheckedAt: oneHourAgo,
    }, now), false);
    // 22h ago — still under 23h
    const twentyTwoHoursAgo = new Date(now - 22 * 60 * 60 * 1000).toISOString();
    assert.equal(X.shouldPoll({
        status: 'pending',
        requestedAt: oneDayAgo,
        lastCheckedAt: twentyTwoHoursAgo,
    }, now), false);
});

test('[CheckExport] shouldPoll returns true when lastCheckedAt > 23h ago', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    // lastCheckedAt = 24h ago, which is > 23h
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    assert.equal(X.shouldPoll({
        status: 'pending',
        requestedAt: twoDaysAgo,
        lastCheckedAt: twentyFourHoursAgo,
    }, now), true);
});

// ---------------------------------------------------------------------------
// POLL_THROTTLE_MS
// ---------------------------------------------------------------------------

test('[CheckExport] POLL_THROTTLE_MS equals 23 hours in ms', () => {
    assert.equal(X.POLL_THROTTLE_MS, 23 * 60 * 60 * 1000);
});
