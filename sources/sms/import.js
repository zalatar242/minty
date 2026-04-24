/**
 * Android SMS Import
 *
 * Parses the XML backup created by "SMS Backup & Restore" (SyncTech, free app).
 *
 * How to export:
 *   1. Install "SMS Backup & Restore" from the Play Store (by SyncTech)
 *   2. Open the app → Backup → select SMS and/or MMS → Back Up Now
 *   3. The backup saves locally to your phone (usually /sdcard/SMSBackupRestore/)
 *   4. Copy the XML file(s) to data/sms/export/ on your computer
 *      (via USB cable, Google Drive, or the app's "Restore from Cloud" share)
 *
 * The app produces files named like:
 *   sms-20240101010101.xml   (SMS only)
 *   mms-20240101010101.xml   (MMS only)
 *   sms-mms-20240101010101.xml  (combined)
 *
 * Usage:
 *   node sources/sms/import.js
 *   SMS_EXPORT_DIR=/path/to/dir node sources/sms/import.js
 *
 * Output:
 *   data/sms/contacts.json    — unique phone numbers with contact names
 *   data/sms/messages.json    — all SMS/MMS threads
 */

const fs = require('fs');
const path = require('path');
const P = require('../_shared/progress');

const EXPORT_DIR = process.env.SMS_EXPORT_DIR
    || path.join(__dirname, '../../data/sms/export');
const OUT_DIR = process.env.SMS_OUT_DIR || path.join(__dirname, '../../data/sms');
const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '../../data');

// type attribute: 1=received, 2=sent
const TYPE_RECEIVED = '1';
const TYPE_SENT = '2';

/**
 * Extract all XML attribute values from a tag string.
 * e.g. '<sms address="+1" body="hi" />' -> { address: '+1', body: 'hi' }
 */
function parseAttrs(tagStr) {
    const attrs = {};
    // Match key="value" or key='value'
    const re = /(\w+)=(?:"([^"]*?)"|'([^']*?)')/g;
    let m;
    while ((m = re.exec(tagStr)) !== null) {
        attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
    return attrs;
}

/**
 * Parse SMS elements from XML text.
 * Returns array of message objects.
 */
function parseSmsElements(xml) {
    const messages = [];
    // Match <sms ... /> or <sms ...></sms>
    const re = /<sms\s([^>]*?)(?:\/>|>.*?<\/sms>)/gs;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const attrs = parseAttrs(m[1]);
        const phone = (attrs.address || '').replace(/[^0-9+]/g, '');
        if (!phone || phone.length < 4) continue;

        const type = attrs.type;
        const dateMs = parseInt(attrs.date, 10);
        messages.push({
            type: 'sms',
            phone,
            contactName: attrs.contact_name && attrs.contact_name !== '(Unknown)'
                ? attrs.contact_name : null,
            body: attrs.body || '',
            direction: type === TYPE_SENT ? 'sent' : 'received',
            timestamp: dateMs ? new Date(dateMs).toISOString() : null,
            readableDate: attrs.readable_date || null,
            read: attrs.read === '1',
        });
    }
    return messages;
}

/**
 * Parse MMS elements from XML text (picture messages, group texts).
 * Extracts text parts only.
 */
function parseMmsElements(xml) {
    const messages = [];
    // Match full <mms ...>...</mms> blocks
    const re = /<mms\s([\s\S]*?)>(\s*<parts>([\s\S]*?)<\/parts>)?[\s\S]*?<\/mms>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const attrs = parseAttrs(m[1]);
        const phone = (attrs.address || '').replace(/[^0-9+]/g, '');
        if (!phone || phone.length < 4) continue;

        // Extract text parts
        const partsXml = m[3] || '';
        const textParts = [];
        const partRe = /<part\s([^>]*?)(?:\/>|>.*?<\/part>)/gs;
        let pm;
        while ((pm = partRe.exec(partsXml)) !== null) {
            const pAttrs = parseAttrs(pm[1]);
            if (pAttrs.ct === 'text/plain' && pAttrs.text && pAttrs.text !== 'null') {
                textParts.push(pAttrs.text);
            }
        }

        const dateMs = parseInt(attrs.date, 10);
        // m_type: 128=sent, 132=received
        const isSent = attrs.m_type === '128';

        messages.push({
            type: 'mms',
            phone,
            contactName: attrs.contact_name && attrs.contact_name !== '(Unknown)'
                ? attrs.contact_name : null,
            body: textParts.join(' ') || null,
            direction: isSent ? 'sent' : 'received',
            timestamp: dateMs ? new Date(dateMs).toISOString() : null,
            readableDate: attrs.readable_date || null,
            read: attrs.read === '1',
            hasMedia: true,
        });
    }
    return messages;
}

function parseXmlFile(filepath) {
    const xml = fs.readFileSync(filepath, 'utf8');
    const sms = parseSmsElements(xml);
    const mms = parseMmsElements(xml);
    return [...sms, ...mms];
}

function groupByPhone(messages) {
    const threads = {};
    for (const msg of messages) {
        if (!threads[msg.phone]) {
            threads[msg.phone] = {
                phone: msg.phone,
                contactName: null,
                messages: [],
            };
        }
        const thread = threads[msg.phone];
        // Use first non-null contact name found
        if (!thread.contactName && msg.contactName) {
            thread.contactName = msg.contactName;
        }
        thread.messages.push(msg);
    }
    // Sort messages within each thread chronologically
    for (const thread of Object.values(threads)) {
        thread.messages.sort((a, b) => {
            if (!a.timestamp) return 1;
            if (!b.timestamp) return -1;
            return new Date(a.timestamp) - new Date(b.timestamp);
        });
    }
    return threads;
}

function run() {
    P.startProgress(DATA_DIR, 'sms', { step: 'init', message: 'Locating XML exports…' });
    if (!fs.existsSync(EXPORT_DIR)) {
        const msg = `SMS export directory not found: ${EXPORT_DIR}`;
        P.failProgress(DATA_DIR, 'sms', new Error(msg));
        console.error(msg);
        console.error('');
        console.error('To export your SMS messages:');
        console.error('  1. Install "SMS Backup & Restore" from the Play Store (by SyncTech)');
        console.error('  2. Open the app → Back Up Now');
        console.error('  3. Copy the XML file(s) to data/sms/export/');
        console.error('');
        console.error('Or set SMS_EXPORT_DIR env var to the directory containing the XML file(s).');
        process.exit(1);
    }

    const xmlFiles = fs.readdirSync(EXPORT_DIR)
        .filter(f => f.endsWith('.xml'))
        .map(f => path.join(EXPORT_DIR, f));

    if (xmlFiles.length === 0) {
        const msg = `No XML files found in ${EXPORT_DIR}`;
        P.failProgress(DATA_DIR, 'sms', new Error(msg));
        console.error(msg);
        process.exit(1);
    }

    console.log(`Found ${xmlFiles.length} XML file(s)`);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    P.updateProgress(DATA_DIR, 'sms', {
        step: 'messages', message: 'Parsing XML…',
        current: 0, total: xmlFiles.length,
    });

    let allMessages = [];
    for (let i = 0; i < xmlFiles.length; i++) {
        const file = xmlFiles[i];
        const msgs = parseXmlFile(file);
        console.log(`  ${path.basename(file)}: ${msgs.length} messages`);
        allMessages = allMessages.concat(msgs);
        P.updateProgress(DATA_DIR, 'sms', {
            current: i + 1, total: xmlFiles.length,
            message: `Parsed ${path.basename(file)}`,
        });
    }

    // Deduplicate by phone+timestamp+body (in case of overlapping backups)
    const seen = new Set();
    allMessages = allMessages.filter(m => {
        const key = `${m.phone}|${m.timestamp}|${m.body}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`Total unique messages: ${allMessages.length}`);

    const threads = groupByPhone(allMessages);
    const threadList = Object.values(threads);

    // contacts.json: unique contacts with phone numbers
    const contacts = threadList.map(t => ({
        name: t.contactName || null,
        phone: t.phone,
        messageCount: t.messages.length,
        lastMessageAt: t.messages.length
            ? t.messages[t.messages.length - 1].timestamp
            : null,
        source: 'sms',
    }));
    fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify(contacts, null, 2));
    console.log(`Saved ${contacts.length} contacts → data/sms/contacts.json`);

    // messages.json: all threads with messages
    fs.writeFileSync(path.join(OUT_DIR, 'messages.json'), JSON.stringify(threadList, null, 2));
    console.log(`Saved ${threadList.length} threads → data/sms/messages.json`);

    P.finishProgress(DATA_DIR, 'sms', {
        message: `Imported ${contacts.length} contacts and ${allMessages.length} messages from ${xmlFiles.length} file(s).`,
        current: xmlFiles.length, total: xmlFiles.length, itemsProcessed: allMessages.length,
    });
}

if (require.main === module) {
    try { run(); } catch (e) { P.failProgress(DATA_DIR, 'sms', e); throw e; }
}

module.exports = { run };
