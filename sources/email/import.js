/**
 * Email Import
 *
 * Two modes:
 *   1. Gmail API (preferred) — set EMAIL_ACCESS_TOKEN env var
 *   2. IMAP fallback — set EMAIL_HOST, EMAIL_USER, EMAIL_PASS
 *
 * Output: contacts.json + messages.json in EMAIL_OUT_DIR
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = process.env.EMAIL_OUT_DIR || path.join(__dirname, '../../data/email');
const LIMIT = parseInt(process.env.EMAIL_LIMIT || '1000');

// ── Shared helpers ─────────────────────────────────────────────────────────

function parseAddrs(str) {
  if (!str) return [];
  return str.split(/,\s*(?=[^<]*(?:<|$))/).map(part => {
    const m = part.match(/^(.*?)\s*<([^>]+)>$/) || part.match(/^([^@\s]+@[^\s]+)$/);
    if (!m) return null;
    const email = (m[2] || m[1] || '').trim().toLowerCase();
    const name = (m[2] ? m[1] : '').trim().replace(/^"|"$/g, '');
    return email ? { name: name || null, email } : null;
  }).filter(Boolean);
}

// ── Gmail API (OAuth) ──────────────────────────────────────────────────────

function gmailGet(accessToken, endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'gmail.googleapis.com',
      path: '/gmail/v1/users/me/' + endpoint,
      headers: { Authorization: 'Bearer ' + accessToken },
    };
    https.get(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Bad JSON: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function fetchEmailsViaGmailAPI(accessToken) {
  const contactMap = {};
  const messages = [];

  // Fetch message IDs (sent + received)
  let pageToken;
  let fetched = 0;
  const ids = [];

  do {
    const qs = 'messages?maxResults=500' + (pageToken ? '&pageToken=' + pageToken : '');
    const res = await gmailGet(accessToken, qs);
    if (res.error) throw new Error('Gmail API error: ' + JSON.stringify(res.error));
    (res.messages || []).forEach(m => ids.push(m.id));
    pageToken = res.nextPageToken;
    fetched += (res.messages || []).length;
  } while (pageToken && fetched < LIMIT);

  console.log(`Fetching metadata for ${Math.min(ids.length, LIMIT)} messages...`);

  // Fetch headers for each message (in batches to avoid rate limits)
  const batchSize = 20;
  for (let i = 0; i < Math.min(ids.length, LIMIT); i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await Promise.all(batch.map(async id => {
      try {
        const msg = await gmailGet(accessToken,
          `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`
        );
        if (msg.error) return;

        const headers = {};
        (msg.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });

        const date = headers.date ? new Date(headers.date).toISOString() : null;
        const allAddrs = [...parseAddrs(headers.from), ...parseAddrs(headers.to), ...parseAddrs(headers.cc)];

        allAddrs.forEach(a => {
          if (!contactMap[a.email]) {
            contactMap[a.email] = { name: a.name, email: a.email, source: 'email', firstSeen: date };
          }
        });

        messages.push({
          messageId: msg.id,
          timestamp: date,
          from: headers.from || null,
          to: headers.to || null,
          cc: headers.cc || null,
          subject: headers.subject || null,
        });
      } catch (e) { /* skip bad messages */ }
    }));
  }

  return { messages, contacts: Object.values(contactMap) };
}

// ── IMAP fallback ──────────────────────────────────────────────────────────

async function fetchEmailsViaIMAP() {
  const Imap = require('imap');
  const { simpleParser } = require('mailparser');

  const imap = new Imap({
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS,
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '993'),
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });

  return new Promise((resolve, reject) => {
    const messages = [];
    const contactMap = {};

    imap.once('ready', () => {
      imap.openBox(process.env.EMAIL_MAILBOX || 'INBOX', true, (err, box) => {
        if (err) return reject(err);
        const total = box.messages.total;
        const start = Math.max(1, total - LIMIT + 1);
        const fetch = imap.seq.fetch(`${start}:*`, { bodies: '' });

        let parseErrors = 0;
        fetch.on('message', msg => {
          const chunks = [];
          msg.on('body', stream => { stream.on('data', c => chunks.push(Buffer.from(c))); });
          msg.once('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            simpleParser(raw).then(parsed => {
              const addContact = addr => {
                if (!addr) return;
                (addr.value || [addr]).forEach(a => {
                  if (!a.address) return;
                  const key = a.address.toLowerCase();
                  if (!contactMap[key]) contactMap[key] = {
                    name: a.name || null, email: a.address, source: 'email',
                    firstSeen: parsed.date ? parsed.date.toISOString() : null,
                  };
                });
              };
              addContact(parsed.from); addContact(parsed.to); addContact(parsed.cc);
              messages.push({
                messageId: parsed.messageId || null,
                timestamp: parsed.date ? parsed.date.toISOString() : null,
                from: parsed.from?.text || null, to: parsed.to?.text || null,
                cc: parsed.cc?.text || null, subject: parsed.subject || null,
                body: parsed.text || null,
              });
            }).catch(e => { parseErrors++; console.warn('Failed to parse message:', e.message); });
          });
        });

        fetch.once('end', () => {
          if (parseErrors) console.warn(`IMAP: ${parseErrors} messages failed to parse`);
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

// ── Microsoft Graph API ────────────────────────────────────────────────────

function graphGet(accessToken, path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'graph.microsoft.com',
      path: '/v1.0/me/' + path,
      headers: { Authorization: 'Bearer ' + accessToken },
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Bad JSON: ' + body.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function fetchEmailsViaMicrosoftGraph(accessToken) {
  const contactMap = {};
  const messages = [];
  let nextLink = `messages?$select=from,toRecipients,ccRecipients,subject,receivedDateTime&$top=100&$orderby=receivedDateTime+desc`;

  while (nextLink && messages.length < LIMIT) {
    const res = await graphGet(accessToken, nextLink.startsWith('http') ? nextLink.replace('https://graph.microsoft.com/v1.0/me/', '') : nextLink);
    if (res.error) throw new Error('Graph API error: ' + JSON.stringify(res.error));

    for (const msg of (res.value || [])) {
      if (messages.length >= LIMIT) break;
      const date = msg.receivedDateTime || null;

      const allAddrs = [
        msg.from?.emailAddress,
        ...(msg.toRecipients || []).map(r => r.emailAddress),
        ...(msg.ccRecipients || []).map(r => r.emailAddress),
      ].filter(Boolean);

      allAddrs.forEach(a => {
        const email = (a.address || '').toLowerCase();
        if (email && !contactMap[email]) {
          contactMap[email] = { name: a.name || null, email, source: 'email', firstSeen: date };
        }
      });

      messages.push({
        messageId: msg.id,
        timestamp: date,
        from: msg.from?.emailAddress ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>` : null,
        to: (msg.toRecipients || []).map(r => `${r.emailAddress.name} <${r.emailAddress.address}>`).join(', ') || null,
        subject: msg.subject || null,
      });
    }

    nextLink = res['@odata.nextLink'] || null;
  }

  return { messages, contacts: Object.values(contactMap) };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const P = require('../_shared/progress');
  const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '../../data');
  P.startProgress(DATA_DIR, 'email', { step: 'init', message: 'Connecting…' });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let result;
  try {
    if (process.env.EMAIL_ACCESS_TOKEN && process.env.EMAIL_TOKEN_TYPE === 'microsoft') {
      console.log('Using Microsoft Graph API (OAuth)...');
      P.updateProgress(DATA_DIR, 'email', { step: 'messages', message: 'Fetching via Microsoft Graph…' });
      result = await fetchEmailsViaMicrosoftGraph(process.env.EMAIL_ACCESS_TOKEN);
    } else if (process.env.EMAIL_ACCESS_TOKEN) {
      console.log('Using Gmail API (OAuth)...');
      P.updateProgress(DATA_DIR, 'email', { step: 'messages', message: 'Fetching via Gmail API…' });
      result = await fetchEmailsViaGmailAPI(process.env.EMAIL_ACCESS_TOKEN);
    } else {
      const missing = ['EMAIL_HOST', 'EMAIL_USER', 'EMAIL_PASS'].filter(k => !process.env[k]);
      if (missing.length) {
        const msg = 'Missing env: ' + missing.join(', ');
        P.failProgress(DATA_DIR, 'email', new Error(msg));
        console.error(msg); process.exit(1);
      }
      console.log(`Connecting via IMAP to ${process.env.EMAIL_HOST}...`);
      P.updateProgress(DATA_DIR, 'email', { step: 'messages', message: `IMAP → ${process.env.EMAIL_HOST}` });
      result = await fetchEmailsViaIMAP();
    }
  } catch (e) {
    P.failProgress(DATA_DIR, 'email', e);
    throw e;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify(result.contacts, null, 2));
  console.log(`Saved ${result.contacts.length} email contacts`);
  fs.writeFileSync(path.join(OUT_DIR, 'messages.json'), JSON.stringify(result.messages, null, 2));
  console.log(`Saved ${result.messages.length} email messages`);
  P.finishProgress(DATA_DIR, 'email', {
    message: `Imported ${result.contacts.length} contacts and ${result.messages.length} messages.`,
    current: result.messages.length, total: result.messages.length, itemsProcessed: result.messages.length,
  });
}

run().catch(err => { console.error(err); process.exit(1); });
