/**
 * LinkedIn Data Import
 *
 * Parses the official LinkedIn data export.
 * Point LINKEDIN_EXPORT_DIR at the extracted folder (defaults to ./linkedin_export).
 *
 * Produces:
 *   data/linkedin/contacts.json      — connections + imported contacts
 *   data/linkedin/messages.json      — message threads (HTML stripped)
 *   data/linkedin/invitations.json   — sent/received connection requests
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const P = require('../_shared/progress');

const EXPORT_DIR = process.env.LINKEDIN_EXPORT_DIR
    || path.join(__dirname, '../../data/linkedin/export');
const OUT_DIR = process.env.LINKEDIN_OUT_DIR || path.join(__dirname, '../../data/linkedin');
const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '../../data');

function readCsv(filename, opts = {}) {
    const filepath = path.join(EXPORT_DIR, filename);
    if (!fs.existsSync(filepath)) {
        console.warn(`  skipping ${filename} (not found)`);
        return [];
    }
    let content = fs.readFileSync(filepath, 'utf8');

    // Some LinkedIn CSVs (e.g. Connections.csv) have a multi-line preamble before the real header.
    // Only skip preamble if the first line doesn't look like a CSV header itself.
    const lines = content.split('\n');
    const firstLine = lines[0].trim();
    const hasPreamble = !firstLine.includes(',') || firstLine.startsWith('Notes');
    if (hasPreamble) {
        const headerIdx = lines.findIndex((line, i) => {
            if (i === 0) return false;
            const trimmed = line.trim();
            return trimmed.length > 0 && !trimmed.startsWith('"When ') && trimmed.includes(',');
        });
        if (headerIdx > 0) content = lines.slice(headerIdx).join('\n');
    }

    return parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_quotes: true,
        ...opts,
    });
}

function stripHtml(html) {
    if (!html) return null;
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function importConnections() {
    const rows = readCsv('Connections.csv');
    return rows.map(r => ({
        firstName: r['First Name'] || '',
        lastName: r['Last Name'] || '',
        name: `${r['First Name'] || ''} ${r['Last Name'] || ''}`.trim(),
        profileUrl: r['URL'] || null,
        email: r['Email Address'] || null,
        company: r['Company'] || null,
        position: r['Position'] || null,
        connectedOn: r['Connected On'] || null,
        location: r['Location'] || null,
        source: 'linkedin',
    }));
}

function importImportedContacts() {
    // Phone/email contacts imported from phone book — useful for cross-matching
    const rows = readCsv('ImportedContacts.csv');
    return rows.map(r => ({
        firstName: r['FirstName'] || '',
        lastName: r['LastName'] || '',
        name: `${r['FirstName'] || ''} ${r['LastName'] || ''}`.trim() || null,
        emails: r['Emails'] ? r['Emails'].split(',').map(e => e.trim()).filter(Boolean) : [],
        phones: r['PhoneNumbers']
            ? r['PhoneNumbers'].split(',').map(p => p.replace(/\\/g, '').trim()).filter(Boolean)
            : [],
        source: 'linkedin_imported',
    }));
}

function importMessages() {
    const rows = readCsv('messages.csv');
    const conversations = {};

    for (const r of rows) {
        const convId = r['CONVERSATION ID'] || 'unknown';
        if (!conversations[convId]) {
            conversations[convId] = {
                id: convId,
                title: r['CONVERSATION TITLE'] || null,
                participants: [],
                messages: [],
            };
        }

        const conv = conversations[convId];
        const sender = r['FROM'] || null;
        const recipients = (r['TO'] || '').split(',').map(s => s.trim()).filter(Boolean);
        const allPeople = [sender, ...recipients].filter(Boolean);
        for (const p of allPeople) {
            if (!conv.participants.includes(p)) conv.participants.push(p);
        }

        conv.messages.push({
            timestamp: r['DATE'] || null,
            from: sender,
            senderProfileUrl: r['SENDER PROFILE URL'] || null,
            to: recipients,
            subject: r['SUBJECT'] || null,
            body: stripHtml(r['CONTENT']),
            folder: r['FOLDER'] || null,
            hasAttachment: !!(r['ATTACHMENTS'] && r['ATTACHMENTS'].trim()),
        });
    }

    // Sort each conversation chronologically
    for (const conv of Object.values(conversations)) {
        conv.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    return Object.values(conversations);
}

function importInvitations() {
    const rows = readCsv('Invitations.csv');
    return rows.map(r => ({
        from: r['From'] || null,
        to: r['To'] || null,
        sentAt: r['Sent At'] || null,
        message: r['Message'] || null,
        direction: r['Direction'] || null,
        fromUrl: r['inviterProfileUrl'] || null,
        toUrl: r['inviteeProfileUrl'] || null,
    }));
}

function run() {
    P.startProgress(DATA_DIR, 'linkedin', { step: 'init', message: 'Reading LinkedIn export…' });
    // Auto-create the export dir so a missing path is a friendly no-op
    // rather than a scary error. This keeps the various import-trigger
    // paths (file watcher, manual /api/sync/trigger, etc.) safe even when
    // nothing's been uploaded — auto-sync's fetch.js still spawns this
    // script with LINKEDIN_EXPORT_DIR pointing at its staging dir, so the
    // happy path stays the same.
    if (!fs.existsSync(EXPORT_DIR)) {
        try { fs.mkdirSync(EXPORT_DIR, { recursive: true }); } catch { /* best-effort */ }
    }
    const csvFiles = ['Connections.csv', 'messages.csv', 'Invitations.csv']
        .filter(f => fs.existsSync(path.join(EXPORT_DIR, f)));
    if (csvFiles.length === 0) {
        console.log(`[linkedin/import] no CSVs in ${EXPORT_DIR} — nothing to import yet.`);
        P.finishProgress(DATA_DIR, 'linkedin', { message: 'No export to import — skipped.' });
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    P.updateProgress(DATA_DIR, 'linkedin', {
        step: 'contacts', message: 'Parsing connections…',
        current: 0, total: 4,
    });
    console.log('Importing LinkedIn connections...');
    const connections = importConnections();
    console.log(`  ${connections.length} connections`);
    P.updateProgress(DATA_DIR, 'linkedin', { current: 1, total: 4 });

    console.log('Importing LinkedIn imported contacts...');
    const importedContacts = importImportedContacts();
    console.log(`  ${importedContacts.length} imported contacts`);
    P.updateProgress(DATA_DIR, 'linkedin', { current: 2, total: 4, message: 'Parsing messages…' });

    const allContacts = [...connections, ...importedContacts];
    fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify(allContacts, null, 2));
    console.log(`  -> data/linkedin/contacts.json (${allContacts.length} total)`);

    P.updateProgress(DATA_DIR, 'linkedin', { step: 'messages', message: 'Parsing messages…' });
    console.log('Importing LinkedIn messages...');
    const conversations = importMessages();
    const totalMessages = conversations.reduce((n, c) => n + c.messages.length, 0);
    fs.writeFileSync(path.join(OUT_DIR, 'messages.json'), JSON.stringify(conversations, null, 2));
    console.log(`  -> data/linkedin/messages.json (${conversations.length} conversations, ${totalMessages} messages)`);
    P.updateProgress(DATA_DIR, 'linkedin', { current: 3, total: 4, message: 'Parsing invitations…' });

    console.log('Importing LinkedIn invitations...');
    const invitations = importInvitations();
    fs.writeFileSync(path.join(OUT_DIR, 'invitations.json'), JSON.stringify(invitations, null, 2));
    console.log(`  -> data/linkedin/invitations.json (${invitations.length} invitations)`);

    P.finishProgress(DATA_DIR, 'linkedin', {
        message: `Imported ${allContacts.length} contacts, ${totalMessages} messages, ${invitations.length} invitations.`,
        current: 4, total: 4, itemsProcessed: totalMessages,
    });
}

if (require.main === module) {
    try { run(); } catch (e) { P.failProgress(DATA_DIR, 'linkedin', e); throw e; }
}

module.exports = { run };
