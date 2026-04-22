/**
 * Email Import (IMAP)
 *
 * Fetches emails via IMAP and extracts contacts + message threads.
 * Supports Gmail, Outlook, Fastmail, and any standard IMAP server.
 *
 * Config via environment variables:
 *   EMAIL_HOST     IMAP server (e.g. imap.gmail.com)
 *   EMAIL_PORT     IMAP port (default: 993)
 *   EMAIL_USER     your email address
 *   EMAIL_PASS     app password or OAuth token
 *   EMAIL_MAILBOX  mailbox to fetch (default: INBOX)
 *   EMAIL_LIMIT    max messages to fetch (default: 1000)
 *
 * For Gmail: use an App Password (myaccount.google.com/apppasswords)
 *
 * Output: data/email/contacts.json + data/email/messages.json
 *
 * Install deps: npm install imap mailparser
 */

const fs = require('fs');
const path = require('path');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const OUT_DIR = path.join(__dirname, '../../data/email');

const config = {
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '993'),
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS,
    mailbox: process.env.EMAIL_MAILBOX || 'INBOX',
    limit: parseInt(process.env.EMAIL_LIMIT || '1000'),
};

function validateConfig() {
    const missing = ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASS'].filter(k => !process.env[k]);
    if (missing.length) {
        console.error('Missing required env vars:', missing.join(', '));
        process.exit(1);
    }
}

function fetchEmails() {
    return new Promise((resolve, reject) => {
        const imap = new Imap({
            user: config.user,
            password: config.password,
            host: config.host,
            port: config.port,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
        });

        const messages = [];
        const contactMap = {};

        imap.once('ready', () => {
            imap.openBox(config.mailbox, true, (err, box) => {
                if (err) return reject(err);

                const total = box.messages.total;
                const start = Math.max(1, total - config.limit + 1);
                const fetch = imap.seq.fetch(`${start}:*`, { bodies: '' });

                fetch.on('message', (msg) => {
                    let raw = '';
                    msg.on('body', stream => {
                        stream.on('data', chunk => raw += chunk.toString());
                    });
                    msg.once('end', () => {
                        simpleParser(raw).then(parsed => {
                            // Extract contacts from headers
                            const addContact = (addr) => {
                                if (!addr) return;
                                (addr.value || [addr]).forEach(a => {
                                    if (!a.address) return;
                                    const key = a.address.toLowerCase();
                                    if (!contactMap[key]) {
                                        contactMap[key] = {
                                            name: a.name || null,
                                            email: a.address,
                                            source: 'email',
                                            firstSeen: parsed.date ? parsed.date.toISOString() : null,
                                        };
                                    }
                                });
                            };
                            addContact(parsed.from);
                            addContact(parsed.to);
                            addContact(parsed.cc);

                            messages.push({
                                messageId: parsed.messageId || null,
                                timestamp: parsed.date ? parsed.date.toISOString() : null,
                                from: parsed.from ? parsed.from.text : null,
                                to: parsed.to ? parsed.to.text : null,
                                cc: parsed.cc ? parsed.cc.text : null,
                                subject: parsed.subject || null,
                                body: parsed.text || null,
                                hasAttachments: (parsed.attachments || []).length > 0,
                            });
                        }).catch(() => {});
                    });
                });

                fetch.once('end', () => {
                    imap.end();
                    resolve({ messages, contacts: Object.values(contactMap) });
                });
                fetch.once('error', reject);
            });
        });

        imap.once('error', reject);
        imap.connect();
    });
}

async function run() {
    validateConfig();
    fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log(`Connecting to ${config.host} as ${config.user}...`);
    const { messages, contacts } = await fetchEmails();

    fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify(contacts, null, 2));
    console.log(`Saved ${contacts.length} email contacts`);

    fs.writeFileSync(path.join(OUT_DIR, 'messages.json'), JSON.stringify(messages, null, 2));
    console.log(`Saved ${messages.length} email messages`);
}

run().catch(err => { console.error(err); process.exit(1); });
