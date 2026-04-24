/**
 * Tests for crm/export.js — portable bundle + optional encryption.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readBundle, serialise, deserialise, exportAll } = require('../../crm/export');

function makeTempData() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-export-'));
    const unified = path.join(dir, 'unified');
    fs.mkdirSync(unified, { recursive: true });
    fs.writeFileSync(path.join(unified, 'contacts.json'), JSON.stringify([
        { id: 'c_1', name: 'Alex' },
        { id: 'c_2', name: 'Priya' },
    ]));
    fs.writeFileSync(path.join(unified, 'interactions.json'), JSON.stringify([
        { id: 'i_1', source: 'email', body: 'hi' },
    ]));
    fs.writeFileSync(path.join(unified, 'goals.json'), JSON.stringify([
        { id: 'g_1', text: 'Raise' },
    ]));
    return dir;
}

test('[Export] readBundle loads core + optional files, ignores missing ones', () => {
    const d = makeTempData();
    const b = readBundle(d);
    assert.equal(b.version, 1);
    assert.equal(b.contacts.length, 2);
    assert.equal(b.interactions.length, 1);
    assert.equal(b.goals.length, 1);
    assert.equal(b.insights, null);      // not present — should be null
    assert.equal(b.stats.contacts, 2);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Export] serialise round-trips plaintext bundle', () => {
    const d = makeTempData();
    const b = readBundle(d);
    const { buffer, encrypted } = serialise(b);
    assert.equal(encrypted, false);
    const restored = deserialise(buffer);
    assert.deepEqual(restored.contacts, b.contacts);
    assert.deepEqual(restored.interactions, b.interactions);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Export] encrypted bundle needs passphrase to decrypt', () => {
    const d = makeTempData();
    const b = readBundle(d);
    const { buffer, encrypted } = serialise(b, { passphrase: 'correct-horse' });
    assert.equal(encrypted, true);
    // Wrong passphrase should throw
    assert.throws(() => deserialise(buffer, { passphrase: 'wrong' }));
    // Right passphrase works
    const restored = deserialise(buffer, { passphrase: 'correct-horse' });
    assert.deepEqual(restored.contacts, b.contacts);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Export] encrypted bundle without passphrase refuses to decrypt', () => {
    const d = makeTempData();
    const b = readBundle(d);
    const { buffer } = serialise(b, { passphrase: 'abc' });
    assert.throws(() => deserialise(buffer));
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Export] exportAll returns timestamped filename and right suffix', () => {
    const d = makeTempData();
    const plain = exportAll(d);
    assert.match(plain.filename, /^minty-.*\.minty\.bundle\.gz$/);
    assert.equal(plain.encrypted, false);

    const enc = exportAll(d, { passphrase: 'x' });
    assert.match(enc.filename, /^minty-.*\.minty\.bundle$/);
    assert.equal(enc.encrypted, true);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Export] compression ratio is sensible (> 2x reduction on redundant JSON)', () => {
    const d = makeTempData();
    // Pad contacts with repetitive data
    const big = [];
    for (let i = 0; i < 200; i++) big.push({ id: 'c_' + i, name: 'Alex ' + i, body: 'aaaaaaaaaaaaa' });
    fs.writeFileSync(path.join(d, 'unified/contacts.json'), JSON.stringify(big));
    const b = readBundle(d);
    const raw = Buffer.byteLength(JSON.stringify(b));
    const { buffer } = serialise(b);
    assert.ok(buffer.length < raw / 2, `expected > 2x compression, got raw=${raw} gz=${buffer.length}`);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Export] bundle is stable — exporting twice produces identical content sans timestamp', () => {
    const d = makeTempData();
    const a = readBundle(d);
    const b = readBundle(d);
    a.exportedAt = b.exportedAt = 'X';
    assert.deepEqual(a, b);
    fs.rmSync(d, { recursive: true, force: true });
});
