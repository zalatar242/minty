'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    CONNECTIONS_HEADER,
    splitName,
    splitOccupation,
    cleanProfileUrl,
    normalizeConnection,
    connectionRowsToCsvMatrix,
    parseConnectionsFromHtml,
} = require('../../sources/linkedin/parse-connections');

// ---------------------------------------------------------------------------
// splitName
// ---------------------------------------------------------------------------

test('splitName: "First Last" splits into first + last', () => {
    assert.deepEqual(splitName('First Last'), { first: 'First', last: 'Last' });
});

test('splitName: single word is first only, last empty', () => {
    assert.deepEqual(splitName('Single'), { first: 'Single', last: '' });
});

test('splitName: "A B C" keeps tail as last name', () => {
    assert.deepEqual(splitName('A B C'), { first: 'A', last: 'B C' });
});

test('splitName: empty string → both empty', () => {
    assert.deepEqual(splitName(''), { first: '', last: '' });
});

test('splitName: whitespace-only → both empty', () => {
    assert.deepEqual(splitName('   '), { first: '', last: '' });
});

test('splitName: null does not throw', () => {
    assert.doesNotThrow(() => splitName(null));
    assert.deepEqual(splitName(null), { first: '', last: '' });
});

test('splitName: undefined does not throw', () => {
    assert.doesNotThrow(() => splitName(undefined));
    assert.deepEqual(splitName(undefined), { first: '', last: '' });
});

test('splitName: unicode diacritics preserved', () => {
    assert.deepEqual(splitName('Zoë Ñoño'), { first: 'Zoë', last: 'Ñoño' });
});

test('splitName: emoji prefix treated as first name token', () => {
    // Real-world case: LinkedIn users put emoji in their name.
    assert.deepEqual(splitName('🦔 james hawkins'), { first: '🦔', last: 'james hawkins' });
});

test('splitName: collapses multiple internal spaces', () => {
    assert.deepEqual(splitName('First   Middle    Last'), { first: 'First', last: 'Middle Last' });
});

test('splitName: trims leading/trailing whitespace', () => {
    assert.deepEqual(splitName('  First Last  '), { first: 'First', last: 'Last' });
});

// ---------------------------------------------------------------------------
// splitOccupation
// ---------------------------------------------------------------------------

test('splitOccupation: "CEO at Company" splits', () => {
    assert.deepEqual(splitOccupation('CEO at Company'), { position: 'CEO', company: 'Company' });
});

test('splitOccupation: title with no "at" yields position only', () => {
    assert.deepEqual(splitOccupation('Just a title'), { position: 'Just a title', company: '' });
});

test('splitOccupation: empty/null/undefined', () => {
    assert.deepEqual(splitOccupation(''), { position: '', company: '' });
    assert.deepEqual(splitOccupation(null), { position: '', company: '' });
    assert.deepEqual(splitOccupation(undefined), { position: '', company: '' });
});

test('splitOccupation: last " at " wins (position may contain "at" text)', () => {
    assert.deepEqual(
        splitOccupation('Looking at opportunities at Acme'),
        { position: 'Looking at opportunities', company: 'Acme' },
    );
});

test('splitOccupation: "Founder & CEO at Foo, Inc."', () => {
    assert.deepEqual(
        splitOccupation('Founder & CEO at Foo, Inc.'),
        { position: 'Founder & CEO', company: 'Foo, Inc.' },
    );
});

test('splitOccupation: bullet separator is NOT treated specially (by design)', () => {
    // NOTE: source does not special-case the "·" bullet. It is left as-is in
    // whichever side of " at " it lands. Documenting observed behavior.
    const out = splitOccupation('CEO at Company · description');
    assert.equal(out.position, 'CEO');
    assert.equal(out.company, 'Company · description');
});

test('splitOccupation: collapses whitespace', () => {
    assert.deepEqual(
        splitOccupation('  CEO   at   Company  '),
        { position: 'CEO', company: 'Company' },
    );
});

// ---------------------------------------------------------------------------
// cleanProfileUrl
// ---------------------------------------------------------------------------

test('cleanProfileUrl: empty/null/undefined → empty string', () => {
    assert.equal(cleanProfileUrl(''), '');
    assert.equal(cleanProfileUrl(null), '');
    assert.equal(cleanProfileUrl(undefined), '');
});

test('cleanProfileUrl: relative /in/foo → absolute with trailing slash', () => {
    assert.equal(cleanProfileUrl('/in/foo'), 'https://www.linkedin.com/in/foo/');
});

test('cleanProfileUrl: absolute URL preserved', () => {
    assert.equal(
        cleanProfileUrl('https://www.linkedin.com/in/foo/'),
        'https://www.linkedin.com/in/foo/',
    );
});

test('cleanProfileUrl: strips query string (tracking params)', () => {
    assert.equal(
        cleanProfileUrl('https://www.linkedin.com/in/foo/?trk=public_profile_browsemap'),
        'https://www.linkedin.com/in/foo/',
    );
});

test('cleanProfileUrl: strips hash fragment', () => {
    assert.equal(
        cleanProfileUrl('https://www.linkedin.com/in/foo/#section'),
        'https://www.linkedin.com/in/foo/',
    );
});

test('cleanProfileUrl: normalizes multiple trailing slashes to one', () => {
    assert.equal(
        cleanProfileUrl('https://www.linkedin.com/in/foo///'),
        'https://www.linkedin.com/in/foo/',
    );
});

test('cleanProfileUrl: relative with tracking query', () => {
    assert.equal(
        cleanProfileUrl('/in/foo/?miniProfileUrn=bar'),
        'https://www.linkedin.com/in/foo/',
    );
});

test('cleanProfileUrl: trims whitespace', () => {
    assert.equal(
        cleanProfileUrl('  /in/foo  '),
        'https://www.linkedin.com/in/foo/',
    );
});

// ---------------------------------------------------------------------------
// normalizeConnection
// ---------------------------------------------------------------------------

test('normalizeConnection: empty record → all empty strings (plus URL empty)', () => {
    const out = normalizeConnection({});
    assert.deepEqual(out, {
        'First Name': '',
        'Last Name': '',
        'URL': '',
        'Email Address': '',
        'Company': '',
        'Position': '',
        'Connected On': '',
        'Location': '',
    });
});

test('normalizeConnection: null record does not throw', () => {
    assert.doesNotThrow(() => normalizeConnection(null));
    assert.doesNotThrow(() => normalizeConnection(undefined));
});

test('normalizeConnection: full record populates all fields', () => {
    const out = normalizeConnection({
        fullName: 'Jane Smith',
        profileUrl: '/in/jane-smith/?trk=x',
        occupation: 'CTO at Acme',
        email: 'jane@example.com',
        connectedOn: '15 Jan 2024',
    });
    assert.equal(out['First Name'], 'Jane');
    assert.equal(out['Last Name'], 'Smith');
    assert.equal(out['URL'], 'https://www.linkedin.com/in/jane-smith/');
    assert.equal(out['Email Address'], 'jane@example.com');
    assert.equal(out['Company'], 'Acme');
    assert.equal(out['Position'], 'CTO');
    assert.equal(out['Connected On'], '15 Jan 2024');
});

test('normalizeConnection: location passes through trimmed', () => {
    const out = normalizeConnection({
        fullName: 'Ada Lovelace',
        location: '  San Francisco Bay Area  ',
    });
    assert.equal(out['Location'], 'San Francisco Bay Area');
});

test('normalizeConnection: explicit position/company override occupation-parsed values', () => {
    const out = normalizeConnection({
        fullName: 'X Y',
        occupation: 'Foo at Bar',
        position: 'Override Position',
        company: 'Override Co',
    });
    assert.equal(out['Position'], 'Override Position');
    assert.equal(out['Company'], 'Override Co');
});

test('normalizeConnection: silently ignores unknown extra fields', () => {
    const out = normalizeConnection({ fullName: 'A B', extraJunk: 'ignored' });
    assert.equal(Object.hasOwn(out, 'extraJunk'), false);
    assert.equal(out['First Name'], 'A');
});

test('normalizeConnection: output has exactly the header keys', () => {
    const out = normalizeConnection({ fullName: 'A B' });
    assert.deepEqual(Object.keys(out).sort(), [...CONNECTIONS_HEADER].sort());
});

// ---------------------------------------------------------------------------
// connectionRowsToCsvMatrix
// ---------------------------------------------------------------------------

test('connectionRowsToCsvMatrix: empty array → empty matrix', () => {
    assert.deepEqual(connectionRowsToCsvMatrix([]), []);
});

test('connectionRowsToCsvMatrix: null input → empty matrix, no throw', () => {
    assert.deepEqual(connectionRowsToCsvMatrix(null), []);
    assert.deepEqual(connectionRowsToCsvMatrix(undefined), []);
});

test('connectionRowsToCsvMatrix: single row column order matches CONNECTIONS_HEADER', () => {
    const matrix = connectionRowsToCsvMatrix([{
        fullName: 'Ada Lovelace',
        profileUrl: '/in/ada/',
        occupation: 'Engineer at Analytical',
        email: 'ada@example.com',
        connectedOn: '1843',
    }]);
    assert.equal(matrix.length, 1);
    assert.equal(matrix[0].length, CONNECTIONS_HEADER.length);
    // First Name, Last Name, URL, Email Address, Company, Position, Connected On
    assert.deepEqual(matrix[0], [
        'Ada',
        'Lovelace',
        'https://www.linkedin.com/in/ada/',
        'ada@example.com',
        'Analytical',
        'Engineer',
        '1843',
        '',
    ]);
});

test('connectionRowsToCsvMatrix: multiple rows preserve input order', () => {
    const matrix = connectionRowsToCsvMatrix([
        { fullName: 'A One' },
        { fullName: 'B Two' },
        { fullName: 'C Three' },
    ]);
    assert.equal(matrix.length, 3);
    assert.equal(matrix[0][0], 'A');
    assert.equal(matrix[1][0], 'B');
    assert.equal(matrix[2][0], 'C');
});

// ---------------------------------------------------------------------------
// parseConnectionsFromHtml
// ---------------------------------------------------------------------------

test('parseConnectionsFromHtml: empty/null → empty array', () => {
    assert.deepEqual(parseConnectionsFromHtml(''), []);
    assert.deepEqual(parseConnectionsFromHtml(null), []);
    assert.deepEqual(parseConnectionsFromHtml(undefined), []);
});

test('parseConnectionsFromHtml: HTML with no /in/ anchors → empty array', () => {
    const html = '<div><p>Nothing of interest here</p></div>';
    assert.deepEqual(parseConnectionsFromHtml(html), []);
});

test('parseConnectionsFromHtml: malformed HTML → no throw, empty or best-effort', () => {
    assert.doesNotThrow(() => parseConnectionsFromHtml('<<<not html>>>'));
    assert.doesNotThrow(() => parseConnectionsFromHtml('<a href='));
});

test('parseConnectionsFromHtml: one card → one row', () => {
    const html = `
        <a href="/in/alice/" data-test-connection-name>Alice Anderson</a>
        <span data-test-connection-occupation>Engineer at Acme</span>
    `;
    const rows = parseConnectionsFromHtml(html);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['First Name'], 'Alice');
    assert.equal(rows[0]['Last Name'], 'Anderson');
    assert.equal(rows[0]['URL'], 'https://www.linkedin.com/in/alice/');
    assert.equal(rows[0]['Position'], 'Engineer');
    assert.equal(rows[0]['Company'], 'Acme');
});

test('parseConnectionsFromHtml: three distinct cards → three rows', () => {
    const html = `
        <a href="/in/alice/" data-test-connection-name>Alice A</a>
        <span data-test-connection-occupation>CEO at Acme</span>
        <a href="/in/bob/" data-test-connection-name>Bob B</a>
        <span data-test-connection-occupation>CTO at Beta</span>
        <a href="/in/carol/" data-test-connection-name>Carol C</a>
        <span data-test-connection-occupation>CFO at Gamma</span>
    `;
    const rows = parseConnectionsFromHtml(html);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]['First Name'], 'Alice');
    assert.equal(rows[1]['First Name'], 'Bob');
    assert.equal(rows[2]['First Name'], 'Carol');
});

test('parseConnectionsFromHtml: duplicate /in/ anchors for same profile de-duped', () => {
    // Each card in live DOM often has multiple anchors to the same /in/slug.
    const html = `
        <a href="/in/dupe/" data-test-connection-name>Dupe Person</a>
        <a href="/in/dupe/">picture link</a>
    `;
    const rows = parseConnectionsFromHtml(html);
    assert.equal(rows.length, 1);
});

test('parseConnectionsFromHtml: card without occupation still produces a row', () => {
    const html = `<a href="/in/nooc/" data-test-connection-name>No Occupation</a>`;
    const rows = parseConnectionsFromHtml(html);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['First Name'], 'No');
    assert.equal(rows[0]['Position'], '');
    assert.equal(rows[0]['Company'], '');
});

test('parseConnectionsFromHtml: name falls back to aria-hidden span when data-test attr absent', () => {
    const html = `
        <a href="/in/fallback/"><span aria-hidden="true">Fallback Name</span></a>
    `;
    const rows = parseConnectionsFromHtml(html);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['First Name'], 'Fallback');
    assert.equal(rows[0]['Last Name'], 'Name');
});

test('parseConnectionsFromHtml: email is not extracted by the HTML parser (by design)', () => {
    // Documenting actual behavior: regex parser does not scrape email.
    const html = `<a href="/in/e/" data-test-connection-name>E F</a>`;
    const rows = parseConnectionsFromHtml(html);
    assert.equal(rows[0]['Email Address'], '');
});
