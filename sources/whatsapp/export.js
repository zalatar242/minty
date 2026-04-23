const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data/whatsapp');
const AUTH_DIR = path.join(__dirname, '../../.wwebjs_auth');

const client = new Client({ authStrategy: new LocalAuth({ dataPath: AUTH_DIR }) });

client.on('qr', qr => {
    const qrPath = path.join(__dirname, '../../qr.png');
    QRCode.toFile(qrPath, qr, { width: 400 }, () => {
        console.log(`QR code saved to: ${qrPath}`);
        console.log('Open that file and scan it with WhatsApp (Settings → Linked Devices → Link a Device)');
    });
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('Authenticated!'));

function downloadImage(url, filepath) {
    return new Promise((resolve) => {
        const file = fs.createWriteStream(filepath);
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, res => {
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(filepath); });
        }).on('error', () => { fs.unlink(filepath, () => {}); resolve(null); });
    });
}

client.on('ready', async () => {
    const META_PATH = path.join(DATA_DIR, 'metadata.json');
    const CHATS_PATH = path.join(DATA_DIR, 'chats.json');
    const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');
    const PIC_DIR = path.join(DATA_DIR, 'profile_pics');

    // Load previous export state for incremental updates
    let lastExportUnix = 0;
    let existingChats = {};
    if (fs.existsSync(META_PATH)) {
        const meta = JSON.parse(fs.readFileSync(META_PATH));
        lastExportUnix = meta.last_export_unix || 0;
        console.log(`Incremental mode: fetching messages since ${new Date(lastExportUnix * 1000).toISOString()}`);
    } else {
        console.log('First run: full export');
    }
    if (fs.existsSync(CHATS_PATH)) {
        existingChats = JSON.parse(fs.readFileSync(CHATS_PATH));
    }
    if (!fs.existsSync(PIC_DIR)) fs.mkdirSync(PIC_DIR, { recursive: true });

    // Export contacts
    console.log('Fetching contacts...');
    const contacts = await client.getContacts();

    // Fetch profile pic URLs in parallel batches for saved contacts
    const savedContacts = contacts.filter(c => c.isMyContact);
    console.log(`Fetching profile pics for ${savedContacts.length} saved contacts...`);
    const BATCH_SIZE = 20;
    const picUrlMap = {};
    for (let i = 0; i < savedContacts.length; i += BATCH_SIZE) {
        const batch = savedContacts.slice(i, i + BATCH_SIZE).map(c => c.id._serialized);
        const results = await client.pupPage.evaluate(async (ids) => {
            const out = {};
            await Promise.all(ids.map(async (wid) => {
                try {
                    const chatWid = window.Store.WidFactory.createWid(wid);
                    const result = await window.Store.ProfilePicThumb.findImpl(chatWid, true);
                    out[wid] = (result && result.attributes && result.attributes.eurl) || null;
                } catch (e) { out[wid] = null; }
            }));
            return out;
        }, batch);
        Object.assign(picUrlMap, results);
        process.stdout.write(`\r  ${Math.min(i + BATCH_SIZE, savedContacts.length)}/${savedContacts.length}`);
    }
    console.log('');

    // Download profile pics
    const contactMap = {};
    for (const c of contacts) {
        const id = c.id._serialized;
        let profilePic = null;
        const picUrl = picUrlMap[id];
        if (picUrl) {
            const picFile = path.join(PIC_DIR, `${id.replace(/[^a-z0-9@._-]/gi, '_')}.jpg`);
            profilePic = await downloadImage(picUrl, picFile);
        }
        contactMap[id] = {
            name: c.name || c.pushname || c.shortName || null,
            number: c.number,
            isMyContact: c.isMyContact,
            isBusiness: c.isBusiness,
            about: c.about || null,
            profilePic,
        };
    }
    fs.writeFileSync(CONTACTS_PATH, JSON.stringify(contactMap, null, 2));
    console.log(`Saved ${contacts.length} contacts`);

    // Export chats
    console.log('Fetching chats...');
    const chats = await client.getChats();
    console.log(`Found ${chats.length} chats. Exporting...`);

    const firstRun = Object.keys(existingChats).length === 0 && !lastExportUnix;
    const fetchLimit = firstRun ? 50 : 2000;
    if (firstRun) console.log(`First run — using ${fetchLimit} msgs/chat. Re-run later to backfill more.`);

    const result = { ...existingChats };
    let totalMsgs = Object.values(result).reduce((n, c) => n + (c.messages?.length || 0), 0);

    for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        process.stdout.write(`\r  [${i + 1}/${chats.length}] ${chat.name || chat.id?._serialized}                    `);

        let messages;
        try {
            messages = await chat.fetchMessages({ limit: fetchLimit });
        } catch (e) {
            console.log(`\n  skipped (${e.message})`);
            continue;
        }

        const newMessages = lastExportUnix
            ? messages.filter(m => m.timestamp > lastExportUnix)
            : messages;

        const formatted = newMessages.map(m => ({
            id: m.id._serialized,
            timestamp: new Date(m.timestamp * 1000).toISOString(),
            from: m.from,
            author: m.author || m.from,
            body: m.body,
            type: m.type,
            hasMedia: m.hasMedia,
            isForwarded: m.isForwarded,
            hasQuotedMsg: m.hasQuotedMsg,
        }));

        const chatMeta = {
            id: chat.id._serialized,
            isGroup: chat.isGroup,
            pinned: chat.pinned,
            archived: chat.archived,
            unreadCount: chat.unreadCount,
            lastMessageTime: chat.lastMessage
                ? new Date(chat.lastMessage.timestamp * 1000).toISOString()
                : null,
            participants: chat.isGroup
                ? (chat.participants || []).map(p => p.id._serialized)
                : null,
        };

        const existing = result[chat.name];
        if (existing) {
            const existingIds = new Set(existing.messages.map(m => m.id));
            const toAppend = formatted.filter(m => !existingIds.has(m.id));
            result[chat.name] = { meta: chatMeta, messages: [...existing.messages, ...toAppend] };
            totalMsgs += toAppend.length;
        } else {
            result[chat.name] = { meta: chatMeta, messages: formatted };
            totalMsgs += formatted.length;
        }

        // Incremental save — progress survives Ctrl-C or crashes
        fs.writeFileSync(CHATS_PATH, JSON.stringify(result, null, 2));
    }
    console.log(`\n  ${totalMsgs.toLocaleString()} messages saved`);

    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(META_PATH, JSON.stringify({
        last_export_at: new Date(now * 1000).toISOString(),
        last_export_unix: now,
        total_chats: chats.length,
        total_contacts: contacts.length,
    }, null, 2));

    console.log(`\nDone! Saved to data/whatsapp/ (${chats.length} chats, ${contacts.length} contacts)`);
    client.destroy();
});

client.on('auth_failure', msg => {
    console.error('Auth failed:', msg);
});

async function initWithRetry(maxAttempts = 5) {
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            await client.initialize();
            return;
        } catch (err) {
            if (i < maxAttempts && err.message && err.message.includes('Execution context was destroyed')) {
                console.log(`WhatsApp reloaded during startup (attempt ${i}/${maxAttempts}), retrying in 5s...`);
                await new Promise(r => setTimeout(r, 5000));
            } else {
                throw err;
            }
        }
    }
}

initWithRetry();
