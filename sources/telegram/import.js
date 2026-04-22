/**
 * Telegram Data Import
 *
 * Parses the JSON export from Telegram Desktop:
 *   Settings > Advanced > Export Telegram Data
 *   Select: Personal chats, Account information, Contacts
 *   Format: JSON
 *
 * Point TELEGRAM_EXPORT_FILE at the result.json from the export.
 *
 * Output: data/telegram/contacts.json + data/telegram/chats.json
 */

const fs = require('fs');
const path = require('path');

const TELEGRAM_EXPORT_FILE = process.env.TELEGRAM_EXPORT_FILE
    || path.join(__dirname, '../../data/telegram/export/result.json');
const OUT_DIR = path.join(__dirname, '../../data/telegram');

function run() {
    if (!fs.existsSync(TELEGRAM_EXPORT_FILE)) {
        console.error(`Telegram export not found: ${TELEGRAM_EXPORT_FILE}`);
        console.error('Export your data from Telegram Desktop and set TELEGRAM_EXPORT_FILE env var.');
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(TELEGRAM_EXPORT_FILE, 'utf8'));
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // Contacts
    const contacts = (data.contacts && data.contacts.list || []).map(c => ({
        firstName: c.first_name || '',
        lastName: c.last_name || '',
        name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        phone: c.phone_number || null,
        userId: c.user_id || null,
        date: c.date || null,
        source: 'telegram',
    }));
    fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify(contacts, null, 2));
    console.log(`Saved ${contacts.length} Telegram contacts`);

    // Chats / messages
    const chats = (data.chats && data.chats.list || []).map(chat => ({
        id: chat.id,
        name: chat.name,
        type: chat.type,  // personal_chat, private_supergroup, private_group, etc.
        messages: (chat.messages || []).map(m => ({
            id: m.id,
            timestamp: m.date,
            from: m.from || m.actor || null,
            fromId: m.from_id || m.actor_id || null,
            body: Array.isArray(m.text)
                ? m.text.map(t => (typeof t === 'string' ? t : t.text || '')).join('')
                : (m.text || ''),
            type: m.type,
            mediaType: m.media_type || null,
            replyToId: m.reply_to_message_id || null,
            forwarded: m.forwarded_from || null,
        })),
    }));
    fs.writeFileSync(path.join(OUT_DIR, 'chats.json'), JSON.stringify(chats, null, 2));
    console.log(`Saved ${chats.length} Telegram chats`);
}

run();
