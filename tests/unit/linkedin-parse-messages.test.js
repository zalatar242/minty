'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    MESSAGES_HEADER,
    normalizeMessage,
    messageRowsToCsvMatrix,
    parseMessagesFromHtml,
} = require('../../sources/linkedin/parse-messages');

// stripTrailing is not re-exported; import the module via require cache hack
// via the public API is enough — but tests for it go through normalizeMessage.
// For direct coverage, pull it from the module.
const stripTrailing = require('../../sources/linkedin/parse-messages').stripTrailing
    || ((s) => (s == null ? '' : String(s)).replace(/\s+$/g, '').replace(/^\s+/, ''));

// ---------------------------------------------------------------------------
// stripTrailing — note: despite its name, source strips both leading and
// trailing whitespace. Tested via observable behavior through normalizeMessage.
// ---------------------------------------------------------------------------

test('stripTrailing: null/undefined → empty string', () => {
    // Exercised through normalizeMessage which passes every string field through.
    const out = normalizeMessage({ fromName: null, timestamp: undefined }, {});
    assert.equal(out['FROM'], '');
    assert.equal(out['DATE'], '');
});

test('stripTrailing: trims trailing whitespace', () => {
    const out = normalizeMessage({ fromName: 'Alice   ' }, {});
    assert.equal(out['FROM'], 'Alice');
});

test('stripTrailing: trims leading whitespace too (observed behavior)', () => {
    const out = normalizeMessage({ fromName: '   Alice' }, {});
    assert.equal(out['FROM'], 'Alice');
});

test('stripTrailing: trims trailing newlines', () => {
    const out = normalizeMessage({ fromName: 'Alice\n\n' }, {});
    assert.equal(out['FROM'], 'Alice');
});

test('stripTrailing: does not touch internal whitespace', () => {
    const out = normalizeMessage({ fromName: 'Alice  B. Cooper' }, {});
    assert.equal(out['FROM'], 'Alice  B. Cooper');
});

test('stripTrailing: does not strip trailing punctuation', () => {
    // Documenting observed behavior — only whitespace is stripped.
    const out = normalizeMessage({ fromName: 'Alice.' }, {});
    assert.equal(out['FROM'], 'Alice.');
});

test('stripTrailing: non-string input coerced to string', () => {
    const out = normalizeMessage({ timestamp: 12345 }, {});
    assert.equal(out['DATE'], '12345');
});

// ---------------------------------------------------------------------------
// normalizeMessage
// ---------------------------------------------------------------------------

test('normalizeMessage: null record and null context → all empty strings', () => {
    const out = normalizeMessage(null, null);
    assert.deepEqual(out, {
        'CONVERSATION ID': '',
        'CONVERSATION TITLE': '',
        'FROM': '',
        'TO': '',
        'DATE': '',
        'SUBJECT': '',
        'CONTENT': '',
        'FOLDER': '',
        'ATTACHMENTS': '',
        'SENDER PROFILE URL': '',
    });
});

test('normalizeMessage: undefined args do not throw', () => {
    assert.doesNotThrow(() => normalizeMessage(undefined, undefined));
});

test('normalizeMessage: output has exactly the header keys', () => {
    const out = normalizeMessage({}, {});
    assert.deepEqual(Object.keys(out).sort(), [...MESSAGES_HEADER].sort());
});

test('normalizeMessage: TO excludes the sender from participants list', () => {
    const out = normalizeMessage(
        { fromName: 'Alice' },
        { participants: ['Alice', 'Bob', 'Carol'] },
    );
    assert.equal(out['TO'], 'Bob, Carol');
});

test('normalizeMessage: TO empty when only sender is a participant', () => {
    const out = normalizeMessage(
        { fromName: 'Alice' },
        { participants: ['Alice'] },
    );
    assert.equal(out['TO'], '');
});

test('normalizeMessage: TO empty when participants missing or non-array', () => {
    assert.equal(normalizeMessage({ fromName: 'Alice' }, {})['TO'], '');
    assert.equal(normalizeMessage({ fromName: 'Alice' }, { participants: 'not an array' })['TO'], '');
});

test('normalizeMessage: TO filters falsy participants', () => {
    const out = normalizeMessage(
        { fromName: 'Alice' },
        { participants: ['Alice', '', null, 'Bob'] },
    );
    assert.equal(out['TO'], 'Bob');
});

test('normalizeMessage: ATTACHMENTS is "1" when hasAttachment truthy, "" otherwise', () => {
    assert.equal(normalizeMessage({ hasAttachment: true }, {})['ATTACHMENTS'], '1');
    assert.equal(normalizeMessage({ hasAttachment: false }, {})['ATTACHMENTS'], '');
    assert.equal(normalizeMessage({ hasAttachment: undefined }, {})['ATTACHMENTS'], '');
});

test('normalizeMessage: CONTENT keeps HTML as-is (no coercion for null)', () => {
    assert.equal(normalizeMessage({ bodyHtml: '<b>hi</b>' }, {})['CONTENT'], '<b>hi</b>');
    assert.equal(normalizeMessage({ bodyHtml: null }, {})['CONTENT'], '');
    assert.equal(normalizeMessage({}, {})['CONTENT'], '');
});

test('normalizeMessage: SUBJECT prefers record.subject over context.subject', () => {
    const out = normalizeMessage(
        { subject: 'Record Subj' },
        { subject: 'Context Subj' },
    );
    assert.equal(out['SUBJECT'], 'Record Subj');
});

test('normalizeMessage: SUBJECT falls back to context.subject', () => {
    const out = normalizeMessage({}, { subject: 'Context Subj' });
    assert.equal(out['SUBJECT'], 'Context Subj');
});

test('normalizeMessage: full record + context populates every field', () => {
    const out = normalizeMessage(
        {
            fromName: 'Alice',
            senderProfileUrl: 'https://www.linkedin.com/in/alice/',
            timestamp: '2024-01-15T12:00:00Z',
            bodyHtml: '<p>Hello</p>',
            hasAttachment: true,
            subject: 'Re: intro',
        },
        {
            conversationId: 'conv-123',
            conversationTitle: 'Project chat',
            folder: 'Inbox',
            participants: ['Alice', 'Bob'],
        },
    );
    assert.equal(out['CONVERSATION ID'], 'conv-123');
    assert.equal(out['CONVERSATION TITLE'], 'Project chat');
    assert.equal(out['FROM'], 'Alice');
    assert.equal(out['TO'], 'Bob');
    assert.equal(out['DATE'], '2024-01-15T12:00:00Z');
    assert.equal(out['SUBJECT'], 'Re: intro');
    assert.equal(out['CONTENT'], '<p>Hello</p>');
    assert.equal(out['FOLDER'], 'Inbox');
    assert.equal(out['ATTACHMENTS'], '1');
    assert.equal(out['SENDER PROFILE URL'], 'https://www.linkedin.com/in/alice/');
});

// ---------------------------------------------------------------------------
// messageRowsToCsvMatrix
// ---------------------------------------------------------------------------

test('messageRowsToCsvMatrix: empty array → empty matrix', () => {
    assert.deepEqual(messageRowsToCsvMatrix([], () => ({})), []);
});

test('messageRowsToCsvMatrix: null input → empty matrix, no throw', () => {
    assert.deepEqual(messageRowsToCsvMatrix(null, () => ({})), []);
    assert.deepEqual(messageRowsToCsvMatrix(undefined, () => ({})), []);
});

test('messageRowsToCsvMatrix: column order matches MESSAGES_HEADER', () => {
    const matrix = messageRowsToCsvMatrix(
        [{
            fromName: 'Alice',
            senderProfileUrl: 'https://www.linkedin.com/in/alice/',
            timestamp: '2024-01-15',
            bodyHtml: 'hi',
            hasAttachment: false,
        }],
        () => ({
            conversationId: 'c1',
            conversationTitle: 't1',
            folder: 'Inbox',
            participants: ['Alice', 'Bob'],
        }),
    );
    assert.equal(matrix.length, 1);
    assert.equal(matrix[0].length, MESSAGES_HEADER.length);
    // Order: CONVERSATION ID, CONVERSATION TITLE, FROM, TO, DATE, SUBJECT, CONTENT, FOLDER, ATTACHMENTS, SENDER PROFILE URL
    assert.deepEqual(matrix[0], [
        'c1',
        't1',
        'Alice',
        'Bob',
        '2024-01-15',
        '',
        'hi',
        'Inbox',
        '',
        'https://www.linkedin.com/in/alice/',
    ]);
});

test('messageRowsToCsvMatrix: contextFor as plain object (non-function) applies to every row', () => {
    const matrix = messageRowsToCsvMatrix(
        [{ fromName: 'A' }, { fromName: 'B' }],
        { conversationId: 'shared' },
    );
    assert.equal(matrix.length, 2);
    assert.equal(matrix[0][0], 'shared');
    assert.equal(matrix[1][0], 'shared');
});

test('messageRowsToCsvMatrix: contextFor callback returning {} yields empty context fields', () => {
    const matrix = messageRowsToCsvMatrix(
        [{ fromName: 'Alice' }],
        () => ({}),
    );
    assert.equal(matrix[0][0], ''); // CONVERSATION ID
    assert.equal(matrix[0][1], ''); // CONVERSATION TITLE
    assert.equal(matrix[0][2], 'Alice'); // FROM
});

test('messageRowsToCsvMatrix: per-row context via callback', () => {
    const records = [{ fromName: 'A' }, { fromName: 'B' }];
    const matrix = messageRowsToCsvMatrix(records, (r) => ({
        conversationId: 'for-' + r.fromName,
    }));
    assert.equal(matrix[0][0], 'for-A');
    assert.equal(matrix[1][0], 'for-B');
});

// ---------------------------------------------------------------------------
// parseMessagesFromHtml
// ---------------------------------------------------------------------------

test('parseMessagesFromHtml: empty/null → empty array', () => {
    assert.deepEqual(parseMessagesFromHtml(''), []);
    assert.deepEqual(parseMessagesFromHtml(null), []);
    assert.deepEqual(parseMessagesFromHtml(undefined), []);
});

test('parseMessagesFromHtml: HTML with nothing recognizable → empty array', () => {
    assert.deepEqual(parseMessagesFromHtml('<div>hi</div>'), []);
});

test('parseMessagesFromHtml: does not throw on malformed HTML', () => {
    assert.doesNotThrow(() => parseMessagesFromHtml('<li class="'));
    assert.doesNotThrow(() => parseMessagesFromHtml('<<<>>>'));
});

test('parseMessagesFromHtml: one bubble with full data → one row', () => {
    const html = `
        <li class="msg-s-event-listitem ">
            <a href="/in/alice/">Alice</a>
            <span data-test-message-sender-name>Alice Anderson</span>
            <time datetime="2024-01-15T12:00:00Z">12:00 PM</time>
            <p data-test-message-body>Hello world</p>
        </li>
    `;
    const rows = parseMessagesFromHtml(html, {
        conversationId: 'c1',
        folder: 'Inbox',
        participants: ['Alice Anderson', 'Bob'],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['FROM'], 'Alice Anderson');
    assert.equal(rows[0]['TO'], 'Bob');
    assert.equal(rows[0]['DATE'], '2024-01-15T12:00:00Z');
    assert.equal(rows[0]['CONTENT'], 'Hello world');
    assert.equal(rows[0]['SENDER PROFILE URL'], '/in/alice/');
    assert.equal(rows[0]['CONVERSATION ID'], 'c1');
    assert.equal(rows[0]['FOLDER'], 'Inbox');
});

test('parseMessagesFromHtml: three bubbles → three rows in source order', () => {
    const html = `
        <li class="msg-s-event-listitem ">
            <a href="/in/alice/">a</a>
            <span data-test-message-sender-name>Alice</span>
            <time datetime="2024-01-15T12:00:00Z">12:00</time>
            <p data-test-message-body>one</p>
        </li>
        <li class="msg-s-event-listitem ">
            <a href="/in/bob/">b</a>
            <span data-test-message-sender-name>Bob</span>
            <time datetime="2024-01-15T12:05:00Z">12:05</time>
            <p data-test-message-body>two</p>
        </li>
        <li class="msg-s-event-listitem ">
            <a href="/in/alice/">a</a>
            <span data-test-message-sender-name>Alice</span>
            <time datetime="2024-01-15T12:06:00Z">12:06</time>
            <p data-test-message-body>three</p>
        </li>
    `;
    const rows = parseMessagesFromHtml(html, { participants: ['Alice', 'Bob'] });
    assert.equal(rows.length, 3);
    assert.equal(rows[0]['FROM'], 'Alice');
    assert.equal(rows[0]['CONTENT'], 'one');
    assert.equal(rows[1]['FROM'], 'Bob');
    assert.equal(rows[1]['CONTENT'], 'two');
    assert.equal(rows[2]['FROM'], 'Alice');
    assert.equal(rows[2]['CONTENT'], 'three');
});

test('parseMessagesFromHtml: bubble without <time> keeps empty DATE', () => {
    // NOTE: source does NOT propagate last-seen timestamp/from across bubbles.
    // Documenting observed behavior.
    const html = `
        <li class="msg-s-event-listitem ">
            <span data-test-message-sender-name>Alice</span>
            <p data-test-message-body>no timestamp here</p>
        </li>
    `;
    const rows = parseMessagesFromHtml(html, {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['DATE'], '');
    assert.equal(rows[0]['FROM'], 'Alice');
});

test('parseMessagesFromHtml: attachment flag detected via dms.licdn.com link', () => {
    const html = `
        <li class="msg-s-event-listitem ">
            <span data-test-message-sender-name>Alice</span>
            <time datetime="2024-01-15T12:00:00Z"></time>
            <p data-test-message-body>see attached</p>
            <a href="https://dms.licdn.com/file/abc">attachment</a>
        </li>
    `;
    const rows = parseMessagesFromHtml(html, {});
    assert.equal(rows[0]['ATTACHMENTS'], '1');
});

test('parseMessagesFromHtml: attachment flag detected via data-test-attachment', () => {
    const html = `
        <li class="msg-s-event-listitem ">
            <span data-test-message-sender-name>Alice</span>
            <time datetime="2024-01-15T12:00:00Z"></time>
            <p data-test-message-body>hi</p>
            <div data-test-attachment></div>
        </li>
    `;
    const rows = parseMessagesFromHtml(html, {});
    assert.equal(rows[0]['ATTACHMENTS'], '1');
});

test('parseMessagesFromHtml: no attachment markers → ATTACHMENTS empty', () => {
    const html = `
        <li class="msg-s-event-listitem ">
            <span data-test-message-sender-name>Alice</span>
            <time datetime="2024-01-15T12:00:00Z"></time>
            <p data-test-message-body>plain text</p>
        </li>
    `;
    const rows = parseMessagesFromHtml(html, {});
    assert.equal(rows[0]['ATTACHMENTS'], '');
});

test('parseMessagesFromHtml: fallback segmenter uses <time> alone when no bubble classes', () => {
    // When segmentBubbles finds no msg-s-event-listitem class, it falls back
    // to segmenting on <time datetime=...> alone.
    const html = `
        <div>
            <time datetime="2024-01-15T12:00:00Z">a</time>
            <a href="/in/x/">x</a>
            <p>Body A</p>
            <time datetime="2024-01-15T12:05:00Z">b</time>
            <a href="/in/y/">y</a>
            <p>Body B</p>
        </div>
    `;
    const rows = parseMessagesFromHtml(html, {});
    assert.equal(rows.length, 2);
    assert.equal(rows[0]['DATE'], '2024-01-15T12:00:00Z');
    assert.equal(rows[1]['DATE'], '2024-01-15T12:05:00Z');
});

test('parseMessagesFromHtml: context is applied to every extracted row', () => {
    const html = `
        <li class="msg-s-event-listitem ">
            <span data-test-message-sender-name>Alice</span>
            <time datetime="2024-01-15T12:00:00Z"></time>
            <p data-test-message-body>one</p>
        </li>
        <li class="msg-s-event-listitem ">
            <span data-test-message-sender-name>Bob</span>
            <time datetime="2024-01-15T12:01:00Z"></time>
            <p data-test-message-body>two</p>
        </li>
    `;
    const rows = parseMessagesFromHtml(html, {
        conversationId: 'shared-conv',
        folder: 'Archive',
        participants: ['Alice', 'Bob'],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]['CONVERSATION ID'], 'shared-conv');
    assert.equal(rows[1]['CONVERSATION ID'], 'shared-conv');
    assert.equal(rows[0]['FOLDER'], 'Archive');
    assert.equal(rows[1]['FOLDER'], 'Archive');
});

test('parseMessagesFromHtml: bubble body falls back to class-based selector when data-test-message-body absent', () => {
    const html = `
        <li class="msg-s-event-listitem ">
            <span data-test-message-sender-name>Alice</span>
            <time datetime="2024-01-15T12:00:00Z"></time>
            <p class="msg-s-event-listitem__body ">fallback body</p>
        </li>
    `;
    const rows = parseMessagesFromHtml(html, {});
    assert.equal(rows[0]['CONTENT'], 'fallback body');
});
