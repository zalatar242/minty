<div align="center">

# Minty

**Your network, unified. Privacy-first.**

A self-hosted **personal CRM** (or PRM — personal relationship manager, if you prefer) that pulls your conversations from WhatsApp, Gmail, LinkedIn, Telegram, SMS, and Google Contacts into one searchable place — then surfaces who you should be talking to, and why. Without sending a byte to a third party.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

<!-- TODO: replace with a real screenshot/GIF once v0.2 UI is recorded -->
<!-- <img src="./docs/hero.png" alt="Minty contact list and detail view" width="800"> -->

</div>

## Why

Your network is scattered across a dozen apps. LinkedIn knows who you work with. WhatsApp knows who you actually talk to. Gmail has the long threads. Telegram has the group chats. None of them talk to each other, and none of them are yours.

Minty pulls them all into a single local database — contacts deduplicated across sources, conversations indexed, everything searchable, and a goal-oriented home view that surfaces who can help you *now*. Runs entirely on your machine. No accounts, no API calls, no tracking.

## Features

- **Unified contact view** — one record per person, merged across WhatsApp, Gmail, LinkedIn, Telegram, SMS, Google Contacts
- **Cross-source dedup** — matches a WhatsApp contact to their LinkedIn profile via name, phone, company, location signals
- **Full conversation timeline** — every message with a contact, in chronological order, regardless of channel
- **Network query (Ask view)** — natural-language search like "who did I meet at that conference in March" or "who works at <company>"
- **Reconnect composer** — context-aware pre-generated drafts for people you're fading away from
- **Calendar integration** — auto meeting prep with cross-referenced contact history
- **Stale data warnings** — know when a contact's last info is 12+ months old
- **Background sync** — live WhatsApp, incremental Gmail, file watchers for other sources
- **Mobile-responsive** — full-screen views and touch targets on phones
- **Local-first** — all data in `data/` on your machine as plain JSON. Nothing leaves.
- **Bring-your-own AI** — local Claude Code CLI or local Ollama model for insights/ranking. No cloud LLM fees.
- **Self-hostable** — single `npm run crm` boots the web UI on `localhost:3456`

## Quick start

```bash
git clone https://github.com/zalatar242/minty.git
cd minty
npm install
npm run crm
```

Open <http://localhost:3456>. You'll see an empty state pointing you at importers. Import one or more sources (below), then the app populates automatically.

## Data sources

Each source is optional. Import whichever you care about.

### WhatsApp
```bash
npm run whatsapp
# First run: scan the QR code in WhatsApp → Linked Devices
# Subsequent runs: session is restored automatically
```
Or use the in-app WhatsApp connector from the **Sources** view (live QR, auto-merge when done).

### LinkedIn
1. LinkedIn → Settings → Data Privacy → Get a copy of your data
2. Request **Connections** and **Messages** (ZIP export)
3. Drag-and-drop the ZIP into the **Sources** view, or:
```bash
LINKEDIN_EXPORT_DIR=/path/to/extracted npm run linkedin
```

### Telegram
1. Telegram Desktop → Settings → Advanced → Export Telegram Data
2. Select **Personal chats**, **Contacts** — format **JSON**
3. Drop `result.json` into Sources, or:
```bash
TELEGRAM_EXPORT_FILE=/path/to/result.json npm run telegram
```

### Gmail / Email
**Option A — in-app Google OAuth** (recommended)
Go to the **Sources** view → Connect Gmail. Uses OAuth device flow, scoped to read-only. Requires `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (see `.env.example`).

**Option B — IMAP (any provider)**
```bash
EMAIL_HOST=imap.gmail.com EMAIL_USER=you@gmail.com EMAIL_PASS=app_password npm run email
```
Requires `npm install imap mailparser` first.

### Google Contacts
In-app: Sources → Connect Google Contacts. Or CSV:
```bash
GOOGLE_CONTACTS_CSV=/path/to/contacts.csv npm run google-contacts
```

### SMS (Android via SMS Backup & Restore)
```bash
SMS_EXPORT_FILE=/path/to/sms-*.xml npm run sms
```

### Merge (runs automatically after imports)
```bash
npm run merge
```
Writes `data/unified/contacts.json` and `data/unified/interactions.json`.

## Privacy

Minty is **offline by default**. The only network traffic:
- WhatsApp importer talks to WhatsApp Web (required for that source)
- Email importer talks to your IMAP / Gmail API (required for that source)
- Optional: Google Calendar API if you opt in to the calendar integration
- Optional: Apollo enrichment (only if you explicitly set `APOLLO_API_KEY`)
- Optional: Ollama or Claude Code CLI, both of which run locally

Everything else — contacts, messages, insights, timelines — lives in `data/` on your disk. No telemetry, no analytics, no phone-home. See [SECURITY.md](./SECURITY.md).

## Project structure

```
crm/
  server.js          # HTTP server + single-page UI
  merge.js           # cross-source dedup and merge
  match.js           # matching engine (WhatsApp ↔ LinkedIn etc.)
  schema.js          # Contact + Interaction data shapes
  sync.js            # background sync daemon
  calendar.js        # Google Calendar integration
  reconnect.js       # reconnect-draft templates
  network-query.js   # natural-language network search
  staleness.js       # stale data detection
  analyze.js         # AI insights pipeline (batch)
  digest.js          # weekly digest builder
  ai.js              # AI backend abstraction (claude / ollama)
  utils.js           # shared pure utils (scoring, ranking)
  query.js           # CLI search + stats
sources/
  whatsapp/          # WhatsApp Web exporter
  linkedin/          # LinkedIn ZIP parser
  telegram/          # Telegram JSON parser
  email/             # IMAP fetcher
  google-contacts/
  sms/
  apollo/            # optional contact enrichment
tests/unit/          # Node built-in test runner suite
ee/                  # reserved for future commercial features
data/                # your local data (gitignored)
```

## Architecture: AI without API credits

Minty deliberately avoids runtime LLM fees. Two supported backends:

- **Claude Code CLI** (default) — if you have `claude` on your PATH, Minty calls it via `claude --print` for insights and ranking. Free if you're already a Claude user.
- **Ollama** — set `AI_BACKEND=ollama` in `.env` and run a local model like `qwen2.5:7b`. Fully offline.

AI outputs (insights, digest, reconnect drafts, query rankings) are pre-computed and cached in `data/unified/*.json`. The web server reads those static files — no API calls at request time.

## Testing

```bash
npm test
```

Runs the unit suite with Node's built-in test runner.

## Commercial use

Minty is released under **AGPL-3.0**. You can self-host it, modify it, and use it personally or commercially, provided you open-source any changes you make under the same license — *including* any hosted/SaaS version.

A **commercial license** (without AGPL obligations) may be offered for organizations that want to embed Minty in proprietary products. Interest? Open an issue.

## Contributing

Contributions welcome — please read [CONTRIBUTING.md](./CONTRIBUTING.md) and our [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) first. Security reports go via [SECURITY.md](./SECURITY.md).

For where the project is headed, see [VISION.md](./VISION.md).

## License

[AGPL-3.0-only](./LICENSE) © Sree Sanakkayala
