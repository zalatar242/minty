'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const creds = require('../../sources/linkedin/credentials');

function freshDir() {
    const d = path.join(os.tmpdir(), 'minty-cred-' + randomUUID());
    fs.mkdirSync(d, { recursive: true });
    return d;
}

function cleanup(d) {
    fs.rmSync(d, { recursive: true, force: true });
}

test('[credentials] read returns null when file missing', () => {
    const d = freshDir();
    try { assert.equal(creds.read(d), null); } finally { cleanup(d); }
});

test('[credentials] write then read round-trips email + password', () => {
    const d = freshDir();
    try {
        creds.write(d, { email: 'sree@example.com', password: 'hunter2' });
        const back = creds.read(d);
        assert.equal(back.email, 'sree@example.com');
        assert.equal(back.password, 'hunter2');
        assert.equal(back.totpSecret, undefined);
    } finally { cleanup(d); }
});

test('[credentials] write preserves totpSecret when provided', () => {
    const d = freshDir();
    try {
        creds.write(d, {
            email: 'sree@example.com',
            password: 'hunter2',
            totpSecret: 'JBSWY3DPEHPK3PXP',
        });
        const back = creds.read(d);
        assert.equal(back.totpSecret, 'JBSWY3DPEHPK3PXP');
    } finally { cleanup(d); }
});

test('[credentials] written file has 0o600 mode', { skip: process.platform === 'win32' }, () => {
    const d = freshDir();
    try {
        creds.write(d, { email: 'a', password: 'b' });
        const st = fs.statSync(creds.credPath(d));
        assert.equal(st.mode & 0o777, 0o600);
    } finally { cleanup(d); }
});

test('[credentials] read refuses if perms are loose', { skip: process.platform === 'win32' }, () => {
    const d = freshDir();
    try {
        creds.write(d, { email: 'a', password: 'b' });
        fs.chmodSync(creds.credPath(d), 0o644);
        assert.throws(() => creds.read(d), { code: 'INSECURE_PERMS' });
    } finally { cleanup(d); }
});

test('[credentials] validate rejects missing email', () => {
    assert.throws(() => creds.validate({ password: 'x' }), /email/);
});

test('[credentials] validate rejects missing password', () => {
    assert.throws(() => creds.validate({ email: 'x' }), /password/);
});

test('[credentials] validate rejects empty email', () => {
    assert.throws(() => creds.validate({ email: '', password: 'x' }), /email/);
});

test('[credentials] validate rejects non-string totpSecret', () => {
    assert.throws(() => creds.validate({ email: 'a', password: 'b', totpSecret: 123 }), /totpSecret/);
});

test('[credentials] validate accepts missing totpSecret', () => {
    assert.doesNotThrow(() => creds.validate({ email: 'a', password: 'b' }));
});

test('[credentials] read throws on malformed JSON', { skip: process.platform === 'win32' }, () => {
    const d = freshDir();
    try {
        fs.mkdirSync(path.dirname(creds.credPath(d)), { recursive: true });
        fs.writeFileSync(creds.credPath(d), 'not json', { mode: 0o600 });
        fs.chmodSync(creds.credPath(d), 0o600);
        assert.throws(() => creds.read(d), /malformed/);
    } finally { cleanup(d); }
});

test('[credentials] write is atomic (no .tmp left behind after success)', () => {
    const d = freshDir();
    try {
        creds.write(d, { email: 'a', password: 'b' });
        assert.ok(!fs.existsSync(creds.credPath(d) + '.tmp'), '.tmp should be gone after rename');
    } finally { cleanup(d); }
});

test('[credentials] exists / remove', () => {
    const d = freshDir();
    try {
        assert.equal(creds.exists(d), false);
        creds.write(d, { email: 'a', password: 'b' });
        assert.equal(creds.exists(d), true);
        creds.remove(d);
        assert.equal(creds.exists(d), false);
        creds.remove(d); // no-op on missing, should not throw
    } finally { cleanup(d); }
});

test('[credentials] write replaces an existing file', () => {
    const d = freshDir();
    try {
        creds.write(d, { email: 'a', password: 'b' });
        creds.write(d, { email: 'c', password: 'd', totpSecret: 'JBSWY3DPEHPK3PXP' });
        const back = creds.read(d);
        assert.equal(back.email, 'c');
        assert.equal(back.password, 'd');
        assert.equal(back.totpSecret, 'JBSWY3DPEHPK3PXP');
    } finally { cleanup(d); }
});
