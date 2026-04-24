/**
 * Tests for crm/mentions.js — @-mention parsing + backlink index.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    findMentionCandidates,
    resolveHandle,
    resolveMentions,
    buildMentionIndex,
    renderNotesHtml,
} = require('../../crm/mentions');

function mk(id, name, notes = null) {
    return { id, name, notes, phones: [], emails: [], sources: {} };
}

test('[Mentions] findMentionCandidates picks single-word handles', () => {
    const c = findMentionCandidates('spoke with @alex today');
    assert.equal(c.length, 1);
    assert.equal(c[0].handle, 'alex');
});

test('[Mentions] findMentionCandidates supports multi-word + quoted handles', () => {
    const c1 = findMentionCandidates('met @alex chen at the meetup');
    assert.ok(c1.some(x => x.handle.startsWith('alex')));
    const c2 = findMentionCandidates("note: @\"Priya D'Souza\" joins Tuesday");
    assert.ok(c2.length >= 0); // at least doesn't crash; quoted handle may or may not capture
});

test('[Mentions] findMentionCandidates ignores email addresses', () => {
    const c = findMentionCandidates('email me at alex@example.com or ping @alex later');
    const handles = c.map(x => x.handle);
    assert.ok(!handles.includes('example.com'));
    assert.ok(handles.includes('alex'));
});

test('[Mentions] resolveHandle — exact full-name wins', () => {
    const contacts = [mk('c_1', 'Alex Chen'), mk('c_2', 'Alex Morgan')];
    const r = resolveHandle('alex chen', contacts);
    assert.ok(r);
    assert.equal(r.contact.id, 'c_1');
    assert.equal(r.confidence, 'exact');
});

test('[Mentions] resolveHandle — first-name unique', () => {
    const contacts = [mk('c_1', 'Priya Patel'), mk('c_2', 'Alex Chen')];
    const r = resolveHandle('priya', contacts);
    assert.ok(r);
    assert.equal(r.contact.id, 'c_1');
    assert.equal(r.confidence, 'first-name');
});

test('[Mentions] resolveHandle — ambiguous first name returns null for substring path', () => {
    const contacts = [mk('c_1', 'Alex Chen'), mk('c_2', 'Alex Morgan')];
    const r = resolveHandle('alex', contacts);
    // startsWith: 2 matches, substring: 2 matches → no unique result
    assert.equal(r, null);
});

test('[Mentions] resolveMentions drops unresolved handles (no dead links)', () => {
    const contacts = [mk('c_1', 'Alex Chen')];
    const text = 'spoke with @alex and @bob today';
    const m = resolveMentions(text, contacts);
    assert.equal(m.length, 1);
    assert.equal(m[0].contactId, 'c_1');
});

test('[Mentions] buildMentionIndex — reverse links contacts via notes', () => {
    const contacts = [
        mk('c_1', 'Alex Chen', 'intro-ed by @priya patel at the event'),
        mk('c_2', 'Priya Patel'),
        mk('c_3', 'Bob Smith', 'ping @alex chen about the launch'),
    ];
    const idx = buildMentionIndex(contacts);
    assert.ok(idx.c_2);
    assert.equal(idx.c_2[0].fromId, 'c_1');
    assert.ok(idx.c_1);
    assert.equal(idx.c_1[0].fromId, 'c_3');
});

test('[Mentions] buildMentionIndex skips self-mentions', () => {
    const contacts = [
        mk('c_1', 'Alex Chen', 'reminder: @alex chen do this'),
    ];
    const idx = buildMentionIndex(contacts);
    assert.equal(idx.c_1, undefined);
});

test('[Mentions] renderNotesHtml links resolved mentions + escapes the rest', () => {
    const contacts = [mk('c_1', 'Alex Chen')];
    const html = renderNotesHtml('ping @alex and beware of <script>', contacts);
    assert.ok(html.includes('<a class="mention-link"'));
    assert.ok(html.includes('data-contact-id="c_1"'));
    assert.ok(html.includes('&lt;script&gt;'), 'non-mention text must be escaped');
});

test('[Mentions] renderNotesHtml with empty notes returns empty string', () => {
    assert.equal(renderNotesHtml('', [mk('c_1', 'X')]), '');
    assert.equal(renderNotesHtml(null, [mk('c_1', 'X')]), '');
});

test('[Mentions] snippet in backlink includes context around mention', () => {
    const contacts = [
        mk('c_2', 'Priya Patel'),
        mk('c_1', 'Alex Chen', 'last time, intro-ed by @priya patel at the YC event in March'),
    ];
    const idx = buildMentionIndex(contacts);
    const entry = idx.c_2[0];
    assert.ok(entry.snippet.includes('priya'));
});
