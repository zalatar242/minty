'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');

const {
    isAccepted,
    recordAccept,
    normalizeInput,
    envBypass,
    promptAccept,
} = require('../../sources/linkedin/tos-gate');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
    const dir = path.join(os.tmpdir(), 'minty-tos-gate-' + randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_err) {
        // best-effort
    }
}

/**
 * Collect all writes to a PassThrough output stream into a buffer string.
 */
function collectOutput(stream) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    return () => Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// normalizeInput
// ---------------------------------------------------------------------------

test('normalizeInput: "I accept" → true', () => {
    assert.equal(normalizeInput('I accept'), true);
});

test('normalizeInput: "i accept" → true', () => {
    assert.equal(normalizeInput('i accept'), true);
});

test('normalizeInput: "  I ACCEPT  " → true (trim + toLowerCase)', () => {
    assert.equal(normalizeInput('  I ACCEPT  '), true);
});

test('normalizeInput: "yes" → false', () => {
    assert.equal(normalizeInput('yes'), false);
});

test('normalizeInput: "accept" → false', () => {
    assert.equal(normalizeInput('accept'), false);
});

test('normalizeInput: "I accept." → false (period rejects)', () => {
    assert.equal(normalizeInput('I accept.'), false);
});

test('normalizeInput: "" → false', () => {
    assert.equal(normalizeInput(''), false);
});

test('normalizeInput: null → false, does not throw', () => {
    assert.doesNotThrow(() => normalizeInput(null));
    assert.equal(normalizeInput(null), false);
});

test('normalizeInput: undefined → false, does not throw', () => {
    assert.doesNotThrow(() => normalizeInput(undefined));
    assert.equal(normalizeInput(undefined), false);
});

// ---------------------------------------------------------------------------
// envBypass
// ---------------------------------------------------------------------------

test('envBypass: unset → false', () => {
    const prev = process.env.LINKEDIN_ACCEPT_TOS;
    delete process.env.LINKEDIN_ACCEPT_TOS;
    try {
        assert.equal(envBypass(), false);
    } finally {
        if (prev !== undefined) process.env.LINKEDIN_ACCEPT_TOS = prev;
    }
});

test('envBypass: LINKEDIN_ACCEPT_TOS=1 → true', () => {
    const prev = process.env.LINKEDIN_ACCEPT_TOS;
    process.env.LINKEDIN_ACCEPT_TOS = '1';
    try {
        assert.equal(envBypass(), true);
    } finally {
        if (prev === undefined) delete process.env.LINKEDIN_ACCEPT_TOS;
        else process.env.LINKEDIN_ACCEPT_TOS = prev;
    }
});

test('envBypass: LINKEDIN_ACCEPT_TOS=yes → false (strict "1" check)', () => {
    const prev = process.env.LINKEDIN_ACCEPT_TOS;
    process.env.LINKEDIN_ACCEPT_TOS = 'yes';
    try {
        assert.equal(envBypass(), false);
    } finally {
        if (prev === undefined) delete process.env.LINKEDIN_ACCEPT_TOS;
        else process.env.LINKEDIN_ACCEPT_TOS = prev;
    }
});

// ---------------------------------------------------------------------------
// isAccepted / recordAccept
// ---------------------------------------------------------------------------

test('isAccepted: non-existent sentinel → false', () => {
    const dir = makeTmpDir();
    try {
        assert.equal(isAccepted(dir), false);
    } finally {
        cleanup(dir);
    }
});

test('recordAccept then isAccepted → true', () => {
    const dir = makeTmpDir();
    try {
        recordAccept(dir);
        assert.equal(isAccepted(dir), true);
        // Also confirm the sentinel file actually exists at the expected path.
        assert.ok(fs.existsSync(path.join(dir, 'linkedin', '.tos-accepted')));
    } finally {
        cleanup(dir);
    }
});

test('isAccepted: corrupted (non-ISO) sentinel → false', () => {
    const dir = makeTmpDir();
    try {
        const file = path.join(dir, 'linkedin', '.tos-accepted');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'not-a-timestamp');
        assert.equal(isAccepted(dir), false);
    } finally {
        cleanup(dir);
    }
});

// ---------------------------------------------------------------------------
// promptAccept
// ---------------------------------------------------------------------------

test('promptAccept: "I accept" on first try → resolves true, output contains warning', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const getOutput = collectOutput(output);

    const p = promptAccept(input, output, 3);
    input.write('I accept\n');

    const result = await p;
    assert.equal(result, true);

    const text = getOutput();
    // Warning content references §8.2 and the typed-accept instruction.
    assert.ok(/§8\.2/.test(text), 'output should mention §8.2');
    assert.ok(/I accept/.test(text), 'output should include typed-accept instruction');
});

test('promptAccept: "yes\\nno\\nI accept\\n" (3 tries, last valid) → resolves true', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const getOutput = collectOutput(output);

    const p = promptAccept(input, output, 3);
    input.write('yes\nno\nI accept\n');

    const result = await p;
    assert.equal(result, true);

    const text = getOutput();
    // Retry message printed at least once for the two wrong answers.
    assert.ok(/Expected exactly/.test(text), 'should print retry message on mismatch');
});

test('promptAccept: three wrong answers, attempts=3 → resolves false', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const p = promptAccept(input, output, 3);
    input.write('yes\nno\nnope\n');

    const result = await p;
    assert.equal(result, false);
});

test('promptAccept: mismatch output contains "Expected exactly"', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const getOutput = collectOutput(output);

    const p = promptAccept(input, output, 3);
    input.write('wrong\nI accept\n');

    const result = await p;
    assert.equal(result, true);
    assert.ok(/Expected exactly/.test(getOutput()));
});
