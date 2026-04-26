'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toCsvRow, toCsvFile } = require('../../sources/linkedin/csv');

// csv-parse is an optional dep (only needed when the LinkedIn ZIP importer
// runs). Skip parse-roundtrip tests gracefully when it isn't installed.
let parse = null;
try {
    ({ parse } = require('csv-parse/sync'));
} catch { /* optional dep missing — round-trip tests will skip */ }
const SKIP_ROUNDTRIP = parse ? false : 'csv-parse not installed (optional dep)';

// ---------------------------------------------------------------------------
// toCsvRow: empty / nullish
// ---------------------------------------------------------------------------

test('toCsvRow: empty array returns empty string', () => {
    assert.equal(toCsvRow([]), '');
});

test('toCsvRow: null/undefined input returns empty string', () => {
    assert.equal(toCsvRow(null), '');
    assert.equal(toCsvRow(undefined), '');
});

test('toCsvRow: empty-string cells are not quoted', () => {
    assert.equal(toCsvRow(['', '', '']), ',,');
});

test('toCsvRow: null/undefined cells become empty string', () => {
    assert.equal(toCsvRow([null, undefined, 'x']), ',,x');
});

// ---------------------------------------------------------------------------
// toCsvRow: no special chars → unquoted
// ---------------------------------------------------------------------------

test('toCsvRow: plain cells are NOT quoted', () => {
    assert.equal(toCsvRow(['alice', 'bob', 'carol']), 'alice,bob,carol');
});

test('toCsvRow: cells with spaces are NOT quoted (RFC 4180 allows)', () => {
    assert.equal(toCsvRow(['hello world', 'foo bar']), 'hello world,foo bar');
});

test('toCsvRow: numeric-looking strings pass through unquoted', () => {
    assert.equal(toCsvRow(['42', '3.14', '-0']), '42,3.14,-0');
});

// ---------------------------------------------------------------------------
// toCsvRow: special chars → quoted + escaped
// ---------------------------------------------------------------------------

test('toCsvRow: cell with comma is quoted', () => {
    assert.equal(toCsvRow(['a,b', 'c']), '"a,b",c');
});

test('toCsvRow: cell with double quote is quoted and escaped', () => {
    assert.equal(toCsvRow(['he said "hi"']), '"he said ""hi"""');
});

test('toCsvRow: cell with newline is quoted', () => {
    assert.equal(toCsvRow(['line1\nline2']), '"line1\nline2"');
});

test('toCsvRow: cell with carriage return is quoted', () => {
    assert.equal(toCsvRow(['a\rb']), '"a\rb"');
});

test('toCsvRow: cell with CRLF is quoted', () => {
    assert.equal(toCsvRow(['a\r\nb']), '"a\r\nb"');
});

test('toCsvRow: cell that is ONLY a double quote', () => {
    assert.equal(toCsvRow(['"']), '""""');
});

test('toCsvRow: cell with pre-escaped-looking "" is re-escaped', () => {
    // Input is literal `""` → must become `""""""` (quote-wrap + double each `"`)
    assert.equal(toCsvRow(['""']), '""""""');
});

test('toCsvRow: empty string next to special-char cell', () => {
    assert.equal(toCsvRow(['', 'a,b', '']), ',"a,b",');
});

// ---------------------------------------------------------------------------
// toCsvRow: unicode / weird content
// ---------------------------------------------------------------------------

test('toCsvRow: unicode content passes through', () => {
    assert.equal(toCsvRow(['héllo', 'café', '日本語', 'emoji']), 'héllo,café,日本語,emoji');
});

test('toCsvRow: zero-width + BOM chars pass through unquoted', () => {
    // Zero-width space U+200B and BOM U+FEFF are not "special" per RFC 4180.
    const zwsp = '​';
    const bom = '﻿';
    assert.equal(toCsvRow([`a${zwsp}b`, `${bom}x`]), `a${zwsp}b,${bom}x`);
});

test('toCsvRow: tab char passes through unquoted (RFC 4180)', () => {
    assert.equal(toCsvRow(['a\tb']), 'a\tb');
});

// ---------------------------------------------------------------------------
// toCsvRow: adversarial / injection
// ---------------------------------------------------------------------------

test('toCsvRow: malicious DM payload is safely escaped', { skip: SKIP_ROUNDTRIP }, () => {
    const payload = '","bobby@tables.com",""';
    const out = toCsvRow(['alice', payload, 'note']);
    // Payload has `,` and `"` so must be fully quoted with internal `"` doubled.
    // Build expected from the spec: wrap in quotes, replace every `"` with `""`.
    const expected = `alice,"${payload.replace(/"/g, '""')}",note`;
    assert.equal(out, expected);
    // Critically: parsing back yields exactly 3 cells, not 5+.
    const parsed = parse(out);
    assert.equal(parsed[0].length, 3);
    assert.equal(parsed[0][1], payload);
});

test('toCsvRow: multi-line DM body stays as one cell', { skip: SKIP_ROUNDTRIP }, () => {
    const body = 'Hey!\r\nAre you free Tuesday?\r\n- Bob';
    const out = toCsvRow(['bob', body, '2026-04-23']);
    const parsed = parse(out);
    assert.equal(parsed[0].length, 3);
    assert.equal(parsed[0][1], body);
});

test('toCsvRow: CSV-formula-looking content (=1+1) is not mangled', () => {
    // We do NOT implement formula-injection guards — just verify we pass through.
    // (Guarding against =, +, -, @ is a separate concern documented in plan.)
    assert.equal(toCsvRow(['=1+1', '@SUM(A1)']), '=1+1,@SUM(A1)');
});

// ---------------------------------------------------------------------------
// toCsvFile
// ---------------------------------------------------------------------------

test('toCsvFile: uses \\r\\n line endings', () => {
    const out = toCsvFile(['a', 'b'], [['1', '2'], ['3', '4']]);
    assert.equal(out, 'a,b\r\n1,2\r\n3,4');
});

test('toCsvFile: empty rows produces just header', () => {
    assert.equal(toCsvFile(['a', 'b'], []), 'a,b');
    assert.equal(toCsvFile(['a', 'b'], null), 'a,b');
});

test('toCsvFile: empty header still emits a line', () => {
    assert.equal(toCsvFile([], [['x']]), '\r\nx');
});

test('toCsvFile: escapes inside header too', () => {
    const out = toCsvFile(['col,1', 'col"2'], [['a', 'b']]);
    assert.equal(out, '"col,1","col""2"\r\na,b');
});

// ---------------------------------------------------------------------------
// Round-trip with csv-parse/sync
// ---------------------------------------------------------------------------

test('round-trip: adversarial cells survive parse', { skip: SKIP_ROUNDTRIP }, () => {
    const header = ['id', 'from', 'body', 'received_at'];
    const rows = [
        ['1', 'alice', 'hello', '2026-04-23'],
        ['2', 'bob', 'multi\r\nline\r\nbody', '2026-04-23'],
        ['3', 'eve', '","bobby@tables.com",""', '2026-04-23'],
        ['4', 'mallory', 'quote " inside', '2026-04-23'],
        ['5', 'unicode', 'héllo 日本 emoji', '2026-04-23'],
        ['6', 'empty-body', '', '2026-04-23'],
        ['7', 'all-specials', ',"\r\n', '2026-04-23']
    ];
    const csv = toCsvFile(header, rows);
    const parsed = parse(csv, { columns: true });
    assert.equal(parsed.length, rows.length);
    for (let i = 0; i < rows.length; i++) {
        assert.equal(parsed[i].id, rows[i][0]);
        assert.equal(parsed[i].from, rows[i][1]);
        assert.equal(parsed[i].body, rows[i][2]);
        assert.equal(parsed[i].received_at, rows[i][3]);
    }
});

test('round-trip: null/undefined cells become empty strings', { skip: SKIP_ROUNDTRIP }, () => {
    const csv = toCsvFile(['a', 'b', 'c'], [[null, undefined, 'x']]);
    const parsed = parse(csv, { columns: true });
    assert.equal(parsed[0].a, '');
    assert.equal(parsed[0].b, '');
    assert.equal(parsed[0].c, 'x');
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

test('toCsvRow: 1000-cell row does not crash', () => {
    const cells = new Array(1000).fill(0).map((_, i) => `cell${i}`);
    const out = toCsvRow(cells);
    assert.equal(out.split(',').length, 1000);
});

test('toCsvRow: 1000-cell adversarial row round-trips', { skip: SKIP_ROUNDTRIP }, () => {
    const cells = new Array(1000).fill(0).map((_, i) =>
        i % 3 === 0 ? `a,b"${i}` : i % 3 === 1 ? `line\n${i}` : `plain${i}`);
    const csv = toCsvFile(cells.map((_, i) => `col${i}`), [cells]);
    const parsed = parse(csv, { columns: false });
    assert.equal(parsed[1].length, 1000);
    for (let i = 0; i < 1000; i++) assert.equal(parsed[1][i], cells[i]);
});
