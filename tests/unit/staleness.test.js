'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    daysSince,
    hoursSince,
    isSourceStale,
    getStaleSources,
    getPrimarySourceWarnings,
    getStalenessMessage,
    getContactDataConfidence,
    getDataHealthSummary,
    SOURCE_THRESHOLDS,
} = require('../../crm/staleness');

const NOW = new Date('2026-03-15T12:00:00Z').getTime();
const iso = (daysAgo) => new Date(NOW - daysAgo * 24 * 3600 * 1000).toISOString();
const isoHrs = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();

// ---------------------------------------------------------------------------
// daysSince
// ---------------------------------------------------------------------------

test('[Staleness] daysSince: null returns null', () => {
    assert.equal(daysSince(null, NOW), null);
});

test('[Staleness] daysSince: undefined returns null', () => {
    assert.equal(daysSince(undefined, NOW), null);
});

test('[Staleness] daysSince: 0 days ago returns 0', () => {
    assert.equal(daysSince(iso(0), NOW), 0);
});

test('[Staleness] daysSince: 5 days ago returns 5', () => {
    assert.equal(daysSince(iso(5), NOW), 5);
});

test('[Staleness] daysSince: 31 days ago returns 31', () => {
    assert.equal(daysSince(iso(31), NOW), 31);
});

test('[Staleness] daysSince: future timestamp returns 0 (not negative)', () => {
    const future = new Date(NOW + 5000).toISOString();
    assert.equal(daysSince(future, NOW), 0);
});

// ---------------------------------------------------------------------------
// hoursSince
// ---------------------------------------------------------------------------

test('[Staleness] hoursSince: null returns null', () => {
    assert.equal(hoursSince(null, NOW), null);
});

test('[Staleness] hoursSince: 2 hours ago returns 2', () => {
    assert.equal(hoursSince(isoHrs(2), NOW), 2);
});

test('[Staleness] hoursSince: 25 hours ago returns 25', () => {
    assert.equal(hoursSince(isoHrs(25), NOW), 25);
});

// ---------------------------------------------------------------------------
// isSourceStale
// ---------------------------------------------------------------------------

test('[Staleness] isSourceStale: null lastSyncAt returns false (not stale — never set up)', () => {
    assert.equal(isSourceStale(null, 30, NOW), false);
});

test('[Staleness] isSourceStale: 29 days, threshold 30 → not stale', () => {
    assert.equal(isSourceStale(iso(29), 30, NOW), false);
});

test('[Staleness] isSourceStale: 31 days, threshold 30 → stale', () => {
    assert.equal(isSourceStale(iso(31), 30, NOW), true);
});

test('[Staleness] isSourceStale: 0 days, threshold 1 → not stale', () => {
    assert.equal(isSourceStale(iso(0), 1, NOW), false);
});

test('[Staleness] isSourceStale: 2 days, threshold 1 → stale', () => {
    assert.equal(isSourceStale(iso(2), 1, NOW), true);
});

// ---------------------------------------------------------------------------
// getStaleSources
// ---------------------------------------------------------------------------

test('[Staleness] getStaleSources: null syncState returns empty array', () => {
    assert.deepEqual(getStaleSources(null, NOW), []);
});

test('[Staleness] getStaleSources: empty object returns empty array', () => {
    assert.deepEqual(getStaleSources({}, NOW), []);
});

test('[Staleness] getStaleSources: source with null lastSyncAt is not reported (never set up)', () => {
    const state = { linkedin: { lastSyncAt: null, status: 'ok' } };
    assert.deepEqual(getStaleSources(state, NOW), []);
});

test('[Staleness] getStaleSources: fresh linkedin is not reported', () => {
    const state = { linkedin: { lastSyncAt: iso(10), status: 'ok' } };
    assert.deepEqual(getStaleSources(state, NOW), []);
});

test('[Staleness] getStaleSources: stale linkedin is reported', () => {
    const state = { linkedin: { lastSyncAt: iso(45), status: 'ok' } };
    const result = getStaleSources(state, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'linkedin');
    assert.equal(result[0].daysSince, 45);
    assert.equal(result[0].thresholdDays, 30);
    assert.equal(result[0].label, 'LinkedIn');
    assert.equal(result[0].stale, true);
});

test('[Staleness] getStaleSources: multiple stale sources returned', () => {
    const state = {
        linkedin: { lastSyncAt: iso(45), status: 'ok' },
        telegram: { lastSyncAt: iso(60), status: 'ok' },
    };
    const result = getStaleSources(state, NOW);
    assert.equal(result.length, 2);
});

test('[Staleness] getStaleSources: email stale after 2 days', () => {
    const state = { email: { lastSyncAt: iso(2), status: 'ok' } };
    const result = getStaleSources(state, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'email');
});

test('[Staleness] getStaleSources: email fresh after 0 days is not reported', () => {
    const state = { email: { lastSyncAt: iso(0), status: 'ok' } };
    assert.deepEqual(getStaleSources(state, NOW), []);
});

// ---------------------------------------------------------------------------
// getPrimarySourceWarnings
// ---------------------------------------------------------------------------

test('[Staleness] getPrimarySourceWarnings: null syncState returns empty array', () => {
    assert.deepEqual(getPrimarySourceWarnings(null, NOW), []);
});

test('[Staleness] getPrimarySourceWarnings: no lastSyncAt → not connected → no warning', () => {
    const state = { whatsapp: { lastSyncAt: null, status: 'idle' } };
    assert.deepEqual(getPrimarySourceWarnings(state, NOW), []);
});

test('[Staleness] getPrimarySourceWarnings: synced 12 hours ago → no warning', () => {
    const state = { whatsapp: { lastSyncAt: isoHrs(12), status: 'active' } };
    assert.deepEqual(getPrimarySourceWarnings(state, NOW), []);
});

test('[Staleness] getPrimarySourceWarnings: synced 25 hours ago → warning', () => {
    const state = { whatsapp: { lastSyncAt: isoHrs(25), status: 'active' } };
    const result = getPrimarySourceWarnings(state, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'whatsapp');
    assert.equal(result[0].severity, 'warning');
    assert.ok(result[0].message.includes('WhatsApp'));
    assert.ok(result[0].message.includes('25 hours'));
});

test('[Staleness] getPrimarySourceWarnings: synced 3 days ago → error severity', () => {
    const state = { email: { lastSyncAt: iso(3), status: 'idle' } };
    const result = getPrimarySourceWarnings(state, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, 'error');
    assert.ok(result[0].message.includes('3 days'));
});

test('[Staleness] getPrimarySourceWarnings: synced 2 days ago → warning severity (not error)', () => {
    const state = { whatsapp: { lastSyncAt: iso(2), status: 'idle' } };
    const result = getPrimarySourceWarnings(state, NOW);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, 'warning');
});

// ---------------------------------------------------------------------------
// getStalenessMessage
// ---------------------------------------------------------------------------

test('[Staleness] getStalenessMessage: null days', () => {
    const msg = getStalenessMessage('linkedin', null);
    assert.ok(msg.includes('never'));
});

test('[Staleness] getStalenessMessage: 0 days → "synced today"', () => {
    const msg = getStalenessMessage('linkedin', 0);
    assert.ok(msg.includes('today'));
});

test('[Staleness] getStalenessMessage: 1 day → "synced yesterday"', () => {
    const msg = getStalenessMessage('linkedin', 1);
    assert.ok(msg.includes('yesterday'));
});

test('[Staleness] getStalenessMessage: 32 days → mentions days old and refresh', () => {
    const msg = getStalenessMessage('linkedin', 32);
    assert.ok(msg.includes('32'));
    assert.ok(msg.includes('LinkedIn'));
});

test('[Staleness] getStalenessMessage: unknown source uses raw name', () => {
    const msg = getStalenessMessage('foobar', 5);
    assert.ok(msg.includes('foobar'));
});

// ---------------------------------------------------------------------------
// getContactDataConfidence
// ---------------------------------------------------------------------------

test('[Staleness] getContactDataConfidence: null contact returns low', () => {
    const result = getContactDataConfidence(null, {}, NOW);
    assert.equal(result.level, 'low');
});

test('[Staleness] getContactDataConfidence: no sources returns low', () => {
    const c = { sources: {}, interactionCount: 0 };
    const result = getContactDataConfidence(c, {}, NOW);
    assert.equal(result.level, 'low');
});

test('[Staleness] getContactDataConfidence: no-interaction contact with fresh linkedin → high', () => {
    const c = { sources: { linkedin: { company: 'Acme' } }, interactionCount: 0 };
    const state = { linkedin: { lastSyncAt: iso(10), status: 'ok' } };
    const result = getContactDataConfidence(c, state, NOW);
    assert.equal(result.level, 'high');
});

test('[Staleness] getContactDataConfidence: no-interaction contact with stale linkedin → medium', () => {
    const c = { sources: { linkedin: { company: 'Acme' } }, interactionCount: 0 };
    const state = { linkedin: { lastSyncAt: iso(45), status: 'stale' } };
    const result = getContactDataConfidence(c, state, NOW);
    assert.equal(result.level, 'medium');
    assert.ok(result.staleSourceLabels.includes('LinkedIn'));
});

test('[Staleness] getContactDataConfidence: interacted contact with fresh sources → high', () => {
    const c = { sources: { whatsapp: {}, linkedin: {} }, interactionCount: 10 };
    const state = {
        whatsapp: { lastSyncAt: isoHrs(2), status: 'active' },
        linkedin: { lastSyncAt: iso(5), status: 'ok' },
    };
    const result = getContactDataConfidence(c, state, NOW);
    assert.equal(result.level, 'high');
    assert.deepEqual(result.staleSourceLabels, []);
});

test('[Staleness] getContactDataConfidence: interacted contact with one stale source → medium', () => {
    const c = { sources: { whatsapp: {}, linkedin: {} }, interactionCount: 5 };
    const state = {
        whatsapp: { lastSyncAt: isoHrs(2), status: 'active' },
        linkedin: { lastSyncAt: iso(45), status: 'stale' },
    };
    const result = getContactDataConfidence(c, state, NOW);
    assert.equal(result.level, 'medium');
    assert.ok(result.staleSourceLabels.includes('LinkedIn'));
});

// ---------------------------------------------------------------------------
// getDataHealthSummary
// ---------------------------------------------------------------------------

test('[Staleness] getDataHealthSummary: empty syncState → ok', () => {
    const result = getDataHealthSummary({}, NOW);
    assert.equal(result.level, 'ok');
});

test('[Staleness] getDataHealthSummary: all fresh → ok', () => {
    const state = {
        whatsapp: { lastSyncAt: isoHrs(1), status: 'active' },
        email: { lastSyncAt: isoHrs(1), status: 'idle' },
    };
    const result = getDataHealthSummary(state, NOW);
    assert.equal(result.level, 'ok');
});

test('[Staleness] getDataHealthSummary: stale linkedin → warning', () => {
    const state = { linkedin: { lastSyncAt: iso(45), status: 'ok' } };
    const result = getDataHealthSummary(state, NOW);
    assert.equal(result.level, 'warning');
    assert.equal(result.staleSources.length, 1);
});

test('[Staleness] getDataHealthSummary: whatsapp unsynced 2 days → warning', () => {
    const state = { whatsapp: { lastSyncAt: iso(2), status: 'idle' } };
    const result = getDataHealthSummary(state, NOW);
    assert.equal(result.level, 'warning');
    assert.equal(result.warnings.length, 1);
});

test('[Staleness] getDataHealthSummary: error status → error', () => {
    const state = { email: { lastSyncAt: iso(3), status: 'error' } };
    const result = getDataHealthSummary(state, NOW);
    assert.equal(result.level, 'error');
});
