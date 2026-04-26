'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RX = require('../../sources/linkedin/request-export');

function mkTemp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-rx-'));
}

test('[RequestExport] requestStatePath resolves <dataDir>/linkedin/.export-request.json', () => {
    const d = mkTemp();
    const p = RX.requestStatePath(d);
    assert.equal(p, path.join(d, 'linkedin', '.export-request.json'));
    fs.rmSync(d, { recursive: true, force: true });
});

test('[RequestExport] readRequestState returns null when file missing', () => {
    const d = mkTemp();
    assert.equal(RX.readRequestState(d), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[RequestExport] readRequestState returns null when JSON is corrupt', () => {
    const d = mkTemp();
    const p = RX.requestStatePath(d);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not valid json');
    assert.equal(RX.readRequestState(d), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[RequestExport] readRequestState returns parsed object when valid', () => {
    const d = mkTemp();
    const p = RX.requestStatePath(d);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const state = { status: 'pending', requestedAt: '2026-04-20T00:00:00.000Z', categories: ['Connections'] };
    fs.writeFileSync(p, JSON.stringify(state));
    const got = RX.readRequestState(d);
    assert.deepEqual(got, state);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[RequestExport] readRequestState returns null when JSON is a non-object (e.g. string)', () => {
    const d = mkTemp();
    const p = RX.requestStatePath(d);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify('just-a-string'));
    assert.equal(RX.readRequestState(d), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[RequestExport] writeRequestState round-trips through readRequestState', () => {
    const d = mkTemp();
    const state = {
        status: 'pending',
        requestedAt: '2026-04-24T12:34:56.000Z',
        categories: ['Connections', 'Messages', 'Imported Contacts'],
        confirmedVia: 'page-text',
    };
    RX.writeRequestState(d, state);
    const got = RX.readRequestState(d);
    assert.deepEqual(got, state);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[RequestExport] writeRequestState creates the linkedin/ subdirectory if missing', () => {
    const d = mkTemp();
    // intentionally do not pre-create d/linkedin/
    RX.writeRequestState(d, { status: 'pending', requestedAt: new Date().toISOString() });
    assert.ok(fs.existsSync(path.join(d, 'linkedin')));
    assert.ok(fs.existsSync(path.join(d, 'linkedin', '.export-request.json')));
    fs.rmSync(d, { recursive: true, force: true });
});

test('[RequestExport] writeRequestState sets 0600 perms on POSIX', { skip: process.platform === 'win32' }, () => {
    const d = mkTemp();
    RX.writeRequestState(d, { status: 'pending', requestedAt: new Date().toISOString() });
    const stat = fs.statSync(RX.requestStatePath(d));
    // mask off file-type bits, keep the permission bits
    const perms = stat.mode & 0o777;
    assert.equal(perms, 0o600, `expected 0600, got 0${perms.toString(8)}`);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[RequestExport] hasPendingRequest returns false for null state', () => {
    assert.equal(RX.hasPendingRequest(null), false);
});

test('[RequestExport] hasPendingRequest returns false when requestedAt is missing', () => {
    assert.equal(RX.hasPendingRequest({ status: 'pending' }), false);
});

test('[RequestExport] hasPendingRequest returns false when status !== "pending"', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    assert.equal(RX.hasPendingRequest({ status: 'auth-required', requestedAt: oneDayAgo }, now), false);
    assert.equal(RX.hasPendingRequest({ status: 'completed', requestedAt: oneDayAgo }, now), false);
    assert.equal(RX.hasPendingRequest({ status: '', requestedAt: oneDayAgo }, now), false);
});

test('[RequestExport] hasPendingRequest returns false when 7+ days old', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(RX.hasPendingRequest({ status: 'pending', requestedAt: sevenDaysAgo }, now), false);
    assert.equal(RX.hasPendingRequest({ status: 'pending', requestedAt: eightDaysAgo }, now), false);
});

test('[RequestExport] hasPendingRequest returns true for 1-day-old pending request', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    assert.equal(RX.hasPendingRequest({ status: 'pending', requestedAt: oneDayAgo }, now), true);
});

test('[RequestExport] hasPendingRequest returns false for invalid requestedAt', () => {
    const now = Date.parse('2026-04-25T00:00:00.000Z');
    assert.equal(RX.hasPendingRequest({ status: 'pending', requestedAt: 'not-a-date' }, now), false);
    assert.equal(RX.hasPendingRequest({ status: 'pending', requestedAt: 'banana' }, now), false);
});
