'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizePhone,
    phoneKey,
    normalizeEmail,
    normalizeName,
} = require('../../crm/utils');

// ---------------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------------

test('normalizePhone: returns null for null/undefined input', () => {
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(undefined), null);
    assert.equal(normalizePhone(''), null);
});

test('normalizePhone: strips spaces, dashes, parens', () => {
    assert.equal(normalizePhone('+44 7911 555 333'), '+447911555333');
    assert.equal(normalizePhone('+1 (650) 123-4567'), '+16501234567');
    assert.equal(normalizePhone('(020) 7946-0000'), '02079460000');
});

test('normalizePhone: preserves leading +', () => {
    assert.equal(normalizePhone('+447911555333'), '+447911555333');
});

test('normalizePhone: converts 011 international prefix to +', () => {
    assert.equal(normalizePhone('011447911555333'), '+447911555333');
});

test('normalizePhone: does not convert short 011 numbers', () => {
    // 011 + fewer than 8 more digits — not an international call, leave as-is
    const result = normalizePhone('01147');
    assert.ok(!result.startsWith('+'));
});

// ---------------------------------------------------------------------------
// phoneKey
// ---------------------------------------------------------------------------

test('phoneKey: returns null for null/empty input', () => {
    assert.equal(phoneKey(null), null);
    assert.equal(phoneKey(''), null);
    assert.equal(phoneKey(undefined), null);
});

test('phoneKey: returns null for numbers shorter than 7 digits', () => {
    assert.equal(phoneKey('12345'), null);
    assert.equal(phoneKey('123456'), null);
});

test('phoneKey: strips + and returns digits only', () => {
    assert.equal(phoneKey('+447911555333'), '447911555333');
    assert.equal(phoneKey('+1 (650) 123-4567'), '16501234567');
});

test('phoneKey: +16308911555 and 16308911555 produce same key', () => {
    assert.equal(phoneKey('+16308911555'), phoneKey('16308911555'));
});

test('phoneKey: 7+ digit threshold', () => {
    assert.equal(phoneKey('1234567'), '1234567');
    assert.equal(phoneKey('123456'),  null);
});

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

test('normalizeEmail: returns null for null input', () => {
    assert.equal(normalizeEmail(null), null);
    assert.equal(normalizeEmail(undefined), null);
});

test('normalizeEmail: lowercases', () => {
    assert.equal(normalizeEmail('User@Example.COM'), 'user@example.com');
});

test('normalizeEmail: trims whitespace', () => {
    assert.equal(normalizeEmail('  user@example.com  '), 'user@example.com');
});

test('normalizeEmail: already normalized email unchanged', () => {
    assert.equal(normalizeEmail('user@example.com'), 'user@example.com');
});

// ---------------------------------------------------------------------------
// normalizeName
// ---------------------------------------------------------------------------

test('normalizeName: returns null for null input', () => {
    assert.equal(normalizeName(null), null);
    assert.equal(normalizeName(undefined), null);
});

test('normalizeName: lowercases and takes first two words', () => {
    assert.equal(normalizeName('John Smith'), 'john smith');
    assert.equal(normalizeName('John Michael Smith'), 'john michael');
});

test('normalizeName: handles single word', () => {
    assert.equal(normalizeName('Madonna'), 'madonna');
});

test('normalizeName: trims and collapses whitespace', () => {
    assert.equal(normalizeName('  Alice   Bob  '), 'alice bob');
});
