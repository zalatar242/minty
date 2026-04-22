'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatSyncAge, getSyncDotState, getOverallSyncHealth } = require('../../crm/utils');

// ---------------------------------------------------------------------------
// formatSyncAge
// ---------------------------------------------------------------------------

const NOW = Date.now();

test('formatSyncAge: null returns "never"', () => {
    assert.equal(formatSyncAge(null, NOW), 'never');
});

test('formatSyncAge: undefined returns "never"', () => {
    assert.equal(formatSyncAge(undefined, NOW), 'never');
});

test('formatSyncAge: 30 seconds ago returns "just now"', () => {
    const iso = new Date(NOW - 30 * 1000).toISOString();
    assert.equal(formatSyncAge(iso, NOW), 'just now');
});

test('formatSyncAge: 3 minutes ago', () => {
    const iso = new Date(NOW - 3 * 60 * 1000).toISOString();
    assert.equal(formatSyncAge(iso, NOW), '3 min ago');
});

test('formatSyncAge: 1 minute ago', () => {
    const iso = new Date(NOW - 60 * 1000).toISOString();
    assert.equal(formatSyncAge(iso, NOW), '1 min ago');
});

test('formatSyncAge: 2 hours ago', () => {
    const iso = new Date(NOW - 2 * 3600 * 1000).toISOString();
    assert.equal(formatSyncAge(iso, NOW), '2 hr ago');
});

test('formatSyncAge: 1 day ago', () => {
    const iso = new Date(NOW - 25 * 3600 * 1000).toISOString();
    assert.equal(formatSyncAge(iso, NOW), '1 day ago');
});

test('formatSyncAge: 5 days ago', () => {
    const iso = new Date(NOW - 5 * 86400 * 1000).toISOString();
    assert.equal(formatSyncAge(iso, NOW), '5 days ago');
});

test('formatSyncAge: 2 months ago', () => {
    const iso = new Date(NOW - 65 * 86400 * 1000).toISOString();
    assert.equal(formatSyncAge(iso, NOW), '2 months ago');
});

test('formatSyncAge: future timestamp returns "just now"', () => {
    const iso = new Date(NOW + 5000).toISOString();
    assert.equal(formatSyncAge(iso, NOW), 'just now');
});

// ---------------------------------------------------------------------------
// getSyncDotState
// ---------------------------------------------------------------------------

test('getSyncDotState: null sourceState returns idle', () => {
    assert.equal(getSyncDotState(null), 'idle');
});

test('getSyncDotState: error status returns error', () => {
    assert.equal(getSyncDotState({ status: 'error', lastSyncAt: null }), 'error');
});

test('getSyncDotState: syncing status returns active', () => {
    assert.equal(getSyncDotState({ status: 'syncing', lastSyncAt: null }), 'active');
});

test('getSyncDotState: active status returns active', () => {
    assert.equal(getSyncDotState({ status: 'active', lastSyncAt: new Date(NOW - 60000).toISOString() }), 'active');
});

test('getSyncDotState: stale status returns stale', () => {
    assert.equal(getSyncDotState({ status: 'stale', lastSyncAt: null }), 'stale');
});

test('getSyncDotState: no lastSyncAt returns idle', () => {
    assert.equal(getSyncDotState({ status: 'ok', lastSyncAt: null }), 'idle');
});

test('getSyncDotState: live source synced 1 hr ago returns ok', () => {
    const iso = new Date(NOW - 3600 * 1000).toISOString();
    assert.equal(getSyncDotState({ status: 'ok', lastSyncAt: iso }, 'live', NOW), 'ok');
});

test('getSyncDotState: live source synced 25 hr ago returns stale', () => {
    const iso = new Date(NOW - 25 * 3600 * 1000).toISOString();
    assert.equal(getSyncDotState({ status: 'ok', lastSyncAt: iso }, 'live', NOW), 'stale');
});

test('getSyncDotState: file source synced 10 days ago returns ok', () => {
    const iso = new Date(NOW - 10 * 86400 * 1000).toISOString();
    assert.equal(getSyncDotState({ status: 'ok', lastSyncAt: iso }, 'file', NOW), 'ok');
});

test('getSyncDotState: file source synced 31 days ago returns stale', () => {
    const iso = new Date(NOW - 31 * 86400 * 1000).toISOString();
    assert.equal(getSyncDotState({ status: 'ok', lastSyncAt: iso }, 'file', NOW), 'stale');
});

// ---------------------------------------------------------------------------
// getOverallSyncHealth
// ---------------------------------------------------------------------------

test('getOverallSyncHealth: null returns idle', () => {
    const result = getOverallSyncHealth(null);
    assert.equal(result.state, 'idle');
});

test('getOverallSyncHealth: empty object returns idle', () => {
    const result = getOverallSyncHealth({});
    assert.equal(result.state, 'idle');
});

test('getOverallSyncHealth: all ok returns ok', () => {
    const iso = new Date(NOW - 5 * 60 * 1000).toISOString();
    const result = getOverallSyncHealth({
        whatsapp: { status: 'ok', lastSyncAt: iso },
        email: { status: 'ok', lastSyncAt: iso },
    });
    assert.equal(result.state, 'ok');
    assert.equal(result.message, 'All sources current');
});

test('getOverallSyncHealth: error state is surfaced', () => {
    const result = getOverallSyncHealth({
        email: { status: 'error', lastSyncAt: null },
    });
    assert.equal(result.state, 'error');
    assert.ok(result.message.includes('Email'));
});

test('getOverallSyncHealth: stale source is surfaced', () => {
    const result = getOverallSyncHealth({
        linkedin: { status: 'stale', lastSyncAt: null },
    });
    assert.equal(result.state, 'stale');
    assert.ok(result.message.includes('LinkedIn'));
});

test('getOverallSyncHealth: error takes precedence over stale', () => {
    const result = getOverallSyncHealth({
        linkedin: { status: 'stale', lastSyncAt: null },
        email: { status: 'error', lastSyncAt: null },
    });
    assert.equal(result.state, 'error');
});

test('getOverallSyncHealth: non-source keys are ignored', () => {
    const result = getOverallSyncHealth({
        _googleOAuthEnabled: true,
    });
    assert.equal(result.state, 'idle');
});
