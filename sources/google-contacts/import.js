/**
 * Google Contacts Import
 *
 * Parses a VCF (vCard) export from Google Contacts.
 *
 * How to export:
 *   1. Go to contacts.google.com
 *   2. Click "Export" in the left sidebar
 *   3. Choose "All contacts" and "vCard (for iOS Contacts)" format
 *   4. Save the .vcf file
 *
 * On Android your contacts sync to Google automatically, so this captures
 * all your regular phone contacts.
 *
 * Usage:
 *   node sources/google-contacts/import.js
 *   GOOGLE_CONTACTS_FILE=/path/to/contacts.vcf node sources/google-contacts/import.js
 *
 * Output: data/google-contacts/contacts.json
 */

const fs = require('fs');
const path = require('path');

const CONTACTS_FILE = process.env.GOOGLE_CONTACTS_FILE
    || path.join(__dirname, '../../data/google-contacts/export/contacts.vcf');
const OUT_DIR = path.join(__dirname, '../../data/google-contacts');

/**
 * Parse a VCF file into an array of vCard property maps.
 * Handles line folding (continuation lines starting with space/tab).
 */
function parseVcf(text) {
    const cards = [];
    // Unfold folded lines (RFC 6350: CRLF followed by whitespace = continuation)
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r?\n/);

    let current = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.toUpperCase() === 'BEGIN:VCARD') {
            current = [];
        } else if (trimmed.toUpperCase() === 'END:VCARD') {
            if (current) {
                cards.push(current);
                current = null;
            }
        } else if (current !== null) {
            current.push(trimmed);
        }
    }
    return cards;
}

/**
 * Extract the value from a vCard property line.
 * Handles encoded values (ENCODING=QUOTED-PRINTABLE) and base64 (skip).
 */
function extractValue(line) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return null;
    const value = line.slice(colonIdx + 1).trim();
    // Skip base64 photo/binary data
    if (!value || value.match(/^[A-Za-z0-9+/]+=*$/) && value.length > 100) return null;
    // Unescape vCard backslash escapes
    return value
        .replace(/\\n/g, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\');
}

/**
 * Get the property name (before any parameters and before the colon).
 * e.g. "TEL;TYPE=MOBILE:+1234" -> "TEL"
 */
function propName(line) {
    return line.split(/[:;]/)[0].toUpperCase();
}

/**
 * Get TYPE parameters from a property line.
 * e.g. "TEL;TYPE=MOBILE;TYPE=VOICE:+1234" -> ["MOBILE", "VOICE"]
 */
function propTypes(line) {
    const colonIdx = line.indexOf(':');
    const propPart = colonIdx !== -1 ? line.slice(0, colonIdx) : line;
    const types = [];
    for (const segment of propPart.split(';').slice(1)) {
        const m = segment.match(/^TYPE=(.+)/i);
        if (m) types.push(...m[1].split(',').map(t => t.toUpperCase()));
    }
    return types;
}

function parseCard(lines) {
    const phones = [];
    const emails = [];
    let name = null;
    let org = null;
    let title = null;
    let note = null;
    let birthday = null;
    let urls = [];

    for (const line of lines) {
        const prop = propName(line);
        const value = extractValue(line);
        if (!value) continue;

        if (prop === 'FN') {
            name = value;
        } else if (prop === 'N' && !name) {
            // N:Last;First;Middle;Prefix;Suffix
            const parts = value.split(';');
            const first = (parts[1] || '').trim();
            const last = (parts[0] || '').trim();
            const full = [first, last].filter(Boolean).join(' ');
            if (full) name = full;
        } else if (prop === 'TEL') {
            const types = propTypes(line);
            const normalized = value.replace(/[^0-9+]/g, '');
            if (normalized.length >= 7) {
                phones.push({ number: normalized, types });
            }
        } else if (prop === 'EMAIL') {
            const types = propTypes(line);
            const email = value.toLowerCase().trim();
            if (email.includes('@')) {
                emails.push({ email, types });
            }
        } else if (prop === 'ORG') {
            org = value.split(';')[0].trim() || null;
        } else if (prop === 'TITLE') {
            title = value;
        } else if (prop === 'NOTE') {
            note = value;
        } else if (prop === 'BDAY') {
            birthday = value;
        } else if (prop === 'URL') {
            urls.push(value);
        }
    }

    if (!name && phones.length === 0 && emails.length === 0) return null;

    return {
        name: name || null,
        phones: phones.map(p => p.number),
        phoneDetails: phones,
        emails: emails.map(e => e.email),
        emailDetails: emails,
        org: org || null,
        title: title || null,
        note: note || null,
        birthday: birthday || null,
        urls,
        source: 'google-contacts',
    };
}

function run() {
    if (!fs.existsSync(CONTACTS_FILE)) {
        console.error(`Google Contacts VCF not found: ${CONTACTS_FILE}`);
        console.error('');
        console.error('To export:');
        console.error('  1. Go to contacts.google.com');
        console.error('  2. Click Export in the left sidebar');
        console.error('  3. Choose "All contacts" and "vCard (for iOS Contacts)"');
        console.error('  4. Save to data/google-contacts/export/contacts.vcf');
        console.error('');
        console.error('Or set GOOGLE_CONTACTS_FILE env var to the file path.');
        process.exit(1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const text = fs.readFileSync(CONTACTS_FILE, 'utf8');
    const rawCards = parseVcf(text);
    console.log(`Parsed ${rawCards.length} vCards`);

    const contacts = rawCards.map(parseCard).filter(Boolean);
    fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify(contacts, null, 2));
    console.log(`Saved ${contacts.length} contacts → data/google-contacts/contacts.json`);
}

run();
