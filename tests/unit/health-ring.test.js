'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { healthRingColor, healthRingOffset } = require('../../crm/utils');

// ---------------------------------------------------------------------------
// healthRingColor
// ---------------------------------------------------------------------------
test('[HealthRing] healthRingColor: score 100 is strong', () => {
    assert.equal(healthRingColor(100), 'strong');
});
test('[HealthRing] healthRingColor: score 70 is strong', () => {
    assert.equal(healthRingColor(70), 'strong');
});
test('[HealthRing] healthRingColor: score 69 is good', () => {
    assert.equal(healthRingColor(69), 'good');
});
test('[HealthRing] healthRingColor: score 40 is good', () => {
    assert.equal(healthRingColor(40), 'good');
});
test('[HealthRing] healthRingColor: score 39 is warm', () => {
    assert.equal(healthRingColor(39), 'warm');
});
test('[HealthRing] healthRingColor: score 20 is warm', () => {
    assert.equal(healthRingColor(20), 'warm');
});
test('[HealthRing] healthRingColor: score 19 is fading', () => {
    assert.equal(healthRingColor(19), 'fading');
});
test('[HealthRing] healthRingColor: score 1 is fading', () => {
    assert.equal(healthRingColor(1), 'fading');
});
test('[HealthRing] healthRingColor: score 0 is none', () => {
    assert.equal(healthRingColor(0), 'none');
});
test('[HealthRing] healthRingColor: null/undefined defaults to none', () => {
    assert.equal(healthRingColor(null), 'none');
    assert.equal(healthRingColor(undefined), 'none');
});

// ---------------------------------------------------------------------------
// healthRingOffset
// ---------------------------------------------------------------------------
const CIRCUMFERENCE = 2 * Math.PI * 21; // ~131.95

test('[HealthRing] healthRingOffset: score 100 gives offset 0', () => {
    assert.equal(healthRingOffset(100), 0);
});
test('[HealthRing] healthRingOffset: score 0 gives full circumference', () => {
    const offset = healthRingOffset(0);
    assert.ok(Math.abs(offset - CIRCUMFERENCE) < 0.2, `expected ~${CIRCUMFERENCE.toFixed(1)}, got ${offset}`);
});
test('[HealthRing] healthRingOffset: score 50 gives half circumference', () => {
    const offset = healthRingOffset(50);
    const expected = CIRCUMFERENCE / 2;
    assert.ok(Math.abs(offset - expected) < 0.2, `expected ~${expected.toFixed(1)}, got ${offset}`);
});
test('[HealthRing] healthRingOffset: score > 100 is clamped to 0', () => {
    assert.equal(healthRingOffset(150), 0);
});
test('[HealthRing] healthRingOffset: score < 0 gives full circumference', () => {
    const offset = healthRingOffset(-10);
    assert.ok(Math.abs(offset - CIRCUMFERENCE) < 0.2);
});
test('[HealthRing] healthRingOffset: null defaults to full circumference', () => {
    const offset = healthRingOffset(null);
    assert.ok(Math.abs(offset - CIRCUMFERENCE) < 0.2);
});
test('[HealthRing] healthRingOffset: returns a number', () => {
    assert.equal(typeof healthRingOffset(75), 'number');
});
