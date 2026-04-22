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

const EXPORT_DIR = process.env.LINKEDIN_EXPORT_DIR
    || path.join(__dirname, '../../data/linkedin/export');
const OUT_DIR = path.join(__dirname, '../../data/linkedin');

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
    if (!fs.existsSync(EXPORT_DIR)) {
        console.error(`LinkedIn export directory not found: ${EXPORT_DIR}`);
        console.error('Set LINKEDIN_EXPORT_DIR env var or place export in ./linkedin_export/');
        process.exit(1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log('Importing LinkedIn connections...');
    const connections = importConnections();
    console.log(`  ${connections.length} connections`);

    console.log('Importing LinkedIn imported contacts...');
    const importedContacts = importImportedContacts();
    console.log(`  ${importedContacts.length} imported contacts`);

    const allContacts = [...connections, ...importedContacts];
    fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify(allContacts, null, 2));
    console.log(`  -> data/linkedin/contacts.json (${allContacts.length} total)`);

    console.log('Importing LinkedIn messages...');
    const conversations = importMessages();
    const totalMessages = conversations.reduce((n, c) => n + c.messages.length, 0);
    fs.writeFileSync(path.join(OUT_DIR, 'messages.json'), JSON.stringify(conversations, null, 2));
    console.log(`  -> data/linkedin/messages.json (${conversations.length} conversations, ${totalMessages} messages)`);

    console.log('Importing LinkedIn invitations...');
    const invitations = importInvitations();
    fs.writeFileSync(path.join(OUT_DIR, 'invitations.json'), JSON.stringify(invitations, null, 2));
    console.log(`  -> data/linkedin/invitations.json (${invitations.length} invitations)`);
}

run();
