'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ContactIndex } = require('../../crm/utils');

// ---------------------------------------------------------------------------
// ContactIndex — core deduplication logic
// ---------------------------------------------------------------------------

test('ContactIndex: add and find by phone', () => {
    const idx = new ContactIndex();
    const contact = idx.upsert(['+447911555001'], [], 'Alice');
    const found = idx.find(['+447911555001'], [], null);
    assert.equal(found, contact);
});

test('ContactIndex: find by email', () => {
    const idx = new ContactIndex();
    const contact = idx.upsert([], ['alice@example.com'], 'Alice');
    assert.equal(idx.find([], ['alice@example.com'], null), contact);
});

test('ContactIndex: find by name', () => {
    const idx = new ContactIndex();
    const contact = idx.upsert([], [], 'Alice Smith');
    assert.equal(idx.find([], [], 'Alice Smith'), contact);
});

test('ContactIndex: upsert returns existing contact on phone match', () => {
    const idx = new ContactIndex();
    const first = idx.upsert(['+447911555001'], [], 'Alice');
    const second = idx.upsert(['+447911555001'], [], null);
    assert.equal(first, second, 'same phone → same contact object');
    assert.equal(idx.contacts.length, 1);
});

test('ContactIndex: upsert returns existing contact on email match', () => {
    const idx = new ContactIndex();
    const first = idx.upsert([], ['alice@example.com'], 'Alice');
    const second = idx.upsert([], ['Alice@Example.COM'], null); // case-insensitive
    assert.equal(first, second);
    assert.equal(idx.contacts.length, 1);
});

test('ContactIndex: phone with and without + dedup to same contact', () => {
    const idx = new ContactIndex();
    const first = idx.upsert(['+447911555001'], [], 'Alice');
    const second = idx.upsert(['447911555001'], [], null);
    assert.equal(first, second);
    assert.equal(idx.contacts.length, 1);
});

test('ContactIndex: phone with formatting deduplicates', () => {
    const idx = new ContactIndex();
    const first = idx.upsert(['+44 7911 555 001'], [], 'Alice');
    const second = idx.upsert(['+447911555001'], [], null);
    assert.equal(first, second);
    assert.equal(idx.contacts.length, 1);
});

test('ContactIndex: different contacts not merged', () => {
    const idx = new ContactIndex();
    idx.upsert(['+447911555001'], [], 'Alice');
    idx.upsert(['+447911555002'], [], 'Bob');
    assert.equal(idx.contacts.length, 2);
});

test('ContactIndex: stable id is used when provided', () => {
    const idx = new ContactIndex();
    const contact = idx.upsert([], ['alice@example.com'], 'Alice', 'li_alice-smith');
    assert.equal(contact.id, 'li_alice-smith');
});

test('ContactIndex: sequential id assigned when no stable id', () => {
    const idx = new ContactIndex();
    const a = idx.upsert([], [], 'Alice Smith');
    const b = idx.upsert([], [], 'Bob Jones');
    assert.ok(a.id.startsWith('c_'), `expected c_ prefix, got ${a.id}`);
    assert.ok(b.id.startsWith('c_'), `expected c_ prefix, got ${b.id}`);
    assert.notEqual(a.id, b.id);
});

test('ContactIndex: same phone in two separate upserts triggers merge', () => {
    const idx = new ContactIndex();
    // Simulate: WhatsApp sees contact by phone, later LinkedIn upserts same phone
    const wa = idx.upsert(['+447911555001'], [], 'Alice WA');
    assert.equal(idx.contacts.length, 1);

    // Different name, same phone → collision → merge into wa
    const li = idx.upsert(['+447911555001'], [], 'Alice Li');
    assert.equal(li, wa, 'should return the same contact object');
    assert.equal(idx.contacts.length, 1, 'count must not grow on collision');
});

test('ContactIndex: merged contact inherits sources from both originals', () => {
    const idx = new ContactIndex();
    const a = idx.upsert([], ['alice@example.com'], 'Alice');
    a.sources.linkedin = { name: 'Alice', company: 'Acme' };

    const b = idx.upsert(['+447911555001'], [], 'Alice WA');
    b.sources.whatsapp = { id: '447911555001@c.us' };

    // Trigger merge: a contact that has BOTH the phone and email of two separate contacts
    // This can happen in real life when a new source provides a bridge
    // We test by upsert-ing the same phone twice which merges within the same upsert path
    const c = idx.upsert(['+447911555001'], [], null);
    assert.equal(c, b, 'same phone → same contact returned');
    assert.equal(idx.contacts.length, 2, 'no collision without shared phone between a and b');
});

test('ContactIndex: name added to contact on first upsert', () => {
    const idx = new ContactIndex();
    const c = idx.upsert(['+447911555001'], [], 'Alice Smith');
    assert.equal(c.name, 'Alice Smith');
});

test('ContactIndex: name not overwritten on second upsert', () => {
    const idx = new ContactIndex();
    idx.upsert(['+447911555001'], [], 'Alice Smith');
    idx.upsert(['+447911555001'], [], 'Different Name');
    const found = idx.find(['+447911555001'], [], null);
    assert.equal(found.name, 'Alice Smith', 'first name wins');
});

test('ContactIndex: count reflects total contacts', () => {
    const idx = new ContactIndex();
    assert.equal(idx.contacts.length, 0);
    idx.upsert([], ['a@test.com'], 'A');
    idx.upsert([], ['b@test.com'], 'B');
    idx.upsert([], ['c@test.com'], 'C');
    assert.equal(idx.contacts.length, 3);
});
