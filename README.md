<div align="center">

# Minty

**Your network, unified. Privacy-first.**

A self-hosted **personal CRM** (or PRM — personal relationship manager, if you prefer) that pulls your conversations from WhatsApp, Gmail, LinkedIn, Telegram, SMS, and Google Contacts into one searchable place — without sending a byte to a third party.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

<!-- TODO: replace with a real screenshot/GIF once v0.1 UI is recorded -->
<!-- <img src="./docs/hero.png" alt="Minty contact list and detail view" width="800"> -->

</div>

## Why

Your network is scattered across a dozen apps. LinkedIn knows who you work with. WhatsApp knows who you actually talk to. Gmail has the long threads. Telegram has the group chats. None of them talk to each other, and none of them are yours.

Minty pulls them all into a single local database — contacts deduplicated across sources, conversations indexed, everything searchable. Runs entirely on your machine. No accounts, no API calls, no tracking.

## Features

- **Unified contact view** — one record per person, merged across all sources
- **Cross-source deduplication** — matches a WhatsApp contact to their LinkedIn profile via name, phone, company signals
- **Full conversation timeline** — every message with a contact, regardless of channel, in chronological order
- **Local-first** — all data in `data/` on your machine as plain JSON. Nothing leaves.
- **No AI API fees** — if you want insights, run Claude Code / your LLM of choice against the local JSON
- **Self-hostable** — single `npm run crm` boots the web UI on `localhost:3456`

## Quick start

```bash
git clone https://github.com/zalatar242/minty.git
cd minty
npm install
npm run crm
```

Open <http://localhost:3456>. You'll see an empty state pointing you at importers. Import one or more sources (below), then re-run the server.

## Data sources

Each source is optional. Import whichever you care about.

### WhatsApp
```bash
npm run whatsapp
# First run: scan the QR code in WhatsApp → Linked Devices
# Subsequent runs: session is restored automatically
```

### LinkedIn
1. LinkedIn → Settings → Data Privacy → Get a copy of your data
2. Request **Connections** and **Messages** (ZIP export)
3. Extract, then:
```bash
LINKEDIN_EXPORT_DIR=/path/to/extracted npm run linkedin
```

### Telegram
1. Telegram Desktop → Settings → Advanced → Export Telegram Data
2. Select **Personal chats**, **Contacts** — format **JSON**
3. Point at `result.json`:
```bash
TELEGRAM_EXPORT_FILE=/path/to/result.json npm run telegram
```

### Email (IMAP)
```bash
# Gmail (use an App Password from myaccount.google.com/apppasswords)
EMAIL_HOST=imap.gmail.com EMAIL_USER=you@gmail.com EMAIL_PASS=xxxx npm run email
```
Requires `npm install imap mailparser` first.

### Google Contacts
Export from contacts.google.com (Google CSV), then:
```bash
GOOGLE_CONTACTS_CSV=/path/to/contacts.csv npm run google-contacts
```

### SMS (Android via SMS Backup & Restore)
Export XML from the [SMS Backup & Restore](https://www.synctech.com.au/sms-backup-restore/) app, then:
```bash
SMS_EXPORT_FILE=/path/to/sms-*.xml npm run sms
```

### Merge
After importing any source:
```bash
npm run merge
```
Writes `data/unified/contacts.json` and `data/unified/interactions.json`.

## Privacy

Minty is **offline by default**. The only network traffic:
- WhatsApp importer talks to WhatsApp Web (required for that source)
- Email importer talks to your IMAP server (required for that source)
- Optional: Apollo enrichment (only if you explicitly opt in with `APOLLO_API_KEY`)

Everything else — contacts, messages, insights, timelines — lives in `data/` on your disk. No telemetry, no analytics, no phone-home. See [SECURITY.md](./SECURITY.md) for how to report issues.

## Project structure

```
crm/
  server.js       # HTTP server + single-page UI
  merge.js        # cross-source dedup and merge
  match.js        # matching engine (WhatsApp ↔ LinkedIn etc.)
  schema.js       # Contact + Interaction data shapes
  query.js        # CLI search/stats
sources/
  whatsapp/       # WhatsApp Web exporter
  linkedin/       # LinkedIn ZIP parser
  telegram/       # Telegram JSON parser
  email/          # IMAP fetcher
  google-contacts/
  sms/
  apollo/         # optional contact enrichment
data/             # your local data (gitignored)
```

## Architecture: AI without API credits

Minty deliberately avoids LLM API fees. If you want AI-assisted insights (e.g. "who should I reach out to this week"), the pattern is:

1. Point Claude Code / your LLM at `data/unified/contacts.json` + `interactions.json`
2. Have it synthesize insights
3. Write results back to `data/unified/insights.json`
4. The UI reads that file — no runtime API calls

This keeps hosting costs at zero and your data on your machine.

## Commercial use

Minty is released under **AGPL-3.0**. You can self-host it, modify it, and use it personally or commercially, provided you open-source any changes you make under the same license — *including* any hosted/SaaS version.

A **commercial license** (without AGPL obligations) may be offered for organizations that want to embed Minty in proprietary products. Interest? Open an issue.

## Contributing

Contributions welcome — please read [CONTRIBUTING.md](./CONTRIBUTING.md) and our [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) first. Security reports go via [SECURITY.md](./SECURITY.md).

For where the project is headed, see [VISION.md](./VISION.md).

## License

[AGPL-3.0-only](./LICENSE) © Sree Sanakkayala
