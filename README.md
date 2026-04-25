<div align="center">

# Minty

**Your network, unified. Privacy-first.**

A self-hosted **personal CRM** (or PRM — personal relationship manager, if you prefer) that pulls your conversations from WhatsApp, Gmail, LinkedIn, Telegram, SMS, and Google Contacts into one searchable place — then surfaces who you should be talking to, and why. Without sending a byte to a third party.

[![CI](https://github.com/zalatar242/minty/actions/workflows/ci.yml/badge.svg)](https://github.com/zalatar242/minty/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/zalatar242/minty?display_name=tag&sort=semver)](https://github.com/zalatar242/minty/releases)
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

> Also: an experimental, ToS-adjacent auto-sync option is available for power users. See the [Advanced — LinkedIn auto-sync](#advanced--linkedin-auto-sync-experimental) section below. **The ZIP flow is the recommended path for most users.**

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

## Advanced — LinkedIn auto-sync (experimental, in development)

> **Status:** This PR lands the foundation modules and Playwright setup for LinkedIn auto-sync. The actual scraper (`connect.js` / `fetch.js`) lands in a follow-up PR once Approach-C (headful login + headless session reuse) has been validated on a real account via `scratch/linkedin-session-probe.js`. Until then, only `npm run linkedin:setup` is functional. The full flow and the tuning knobs below describe the target end-state.

> **LinkedIn auto-sync will be prohibited by LinkedIn's User Agreement §8.2.** You are responsible for your own account. LinkedIn may restrict, challenge, or suspend it. Minty cannot protect you from this. If you want the maximum-safety option, use the ZIP flow above and stop here.

The ZIP flow has a real downside: LinkedIn takes up to 24 hours to produce the export, so the "unified network" moment is a day late. Auto-sync will close that gap by driving a real headful browser session on your own machine. It is opt-in at every layer — Playwright isn't installed by default, the endpoints are gated behind a feature flag, and the first run requires a typed ToS acknowledgement.

### Setup

```bash
# Install Playwright (adds ~300MB). Opt-in; the core Minty install skips this.
npm run linkedin:setup
```

### Manual-login flow (default)

```bash
# Open the real LinkedIn login in a headful Chromium window. Log in, solve 2FA, close the window.
MINTY_LINKEDIN_AUTOSYNC=1 npm run linkedin:connect

# Scrape your connections + messages into Minty's unified store.
MINTY_LINKEDIN_AUTOSYNC=1 npm run linkedin:sync
```

Once you've connected, the Sources view in `npm run crm` gains a "Sync now" button that does the same thing as `npm run linkedin:sync`.

### Auto-login flow (store credentials locally)

If you'd rather not type your password every time the session expires, Minty can log in for you using stored credentials. **This is a higher-trust trade-off:** email + password + (optionally) your authenticator-app TOTP secret live plaintext at `data/linkedin/credentials.json` with `0o600` permissions. Disk encryption at the OS level (FileVault / LUKS / BitLocker) is load-bearing — without it, same-user malware can read the file. If that's not your setup, use the manual flow above instead.

```bash
# One-time interactive setup — prompts for email, password, optional TOTP
# secret. Saves to disk then exits (does NOT launch a browser).
npm run linkedin:save-creds

# Same as save-creds, but also runs an auto-login immediately after saving.
# Useful for end-to-end verification that your password + TOTP secret work.
# Fails fast if LinkedIn rejects the credentials.
MINTY_LINKEDIN_AUTOSYNC=1 npm run linkedin:save-and-verify

# Subsequent connects auto-login using the stored creds (no prompt).
MINTY_LINKEDIN_AUTOSYNC=1 npm run linkedin:connect

# Wipe stored creds if you change your mind:
npm run linkedin:forget-creds
```

**TOTP secret** (optional but recommended if your LinkedIn account has 2FA): LinkedIn supports "Authenticator app" 2FA under **Settings → Sign in & security → Two-step verification → Authenticator app**. When you enable it, LinkedIn shows a base32 string alongside the QR code — save that string before scanning. That's what goes in the TOTP prompt. Without it, auto-login will still handle the email+password step but will fall back to manual when LinkedIn challenges (the browser window stays open for you to complete 2FA by hand).

If auto-login fails for any reason (wrong password, unexpected challenge, CAPTCHA, rate limit), the Chromium window stays open and the flow falls back to manual. You'll see a reason in stderr.

To force the manual flow even with stored creds: `LINKEDIN_MANUAL=1 npm run linkedin:connect`.

### Known limitations

- **Session survival:** best-effort ≥7 days; LinkedIn will occasionally challenge and require re-running `linkedin:connect`.
- **Some ZIP-only fields don't survive:** `ImportedContacts.csv` (phone-book data) and `Invitations.csv` (sent/received requests) are only available via the ZIP flow.
- **Headless servers (NAS, Pi):** the initial `linkedin:connect` needs a GUI. Workaround: do initial login on your laptop and ensure disk-level encryption protects `data/linkedin/browser-profile/`.

### Tuning (env vars)

| Env var | Default | Purpose |
|---|---|---|
| `LINKEDIN_EXPORT_DIR` | `./data/linkedin/export` | Where ZIP import looks for CSVs |
| `LINKEDIN_PROFILE_DIR` | `./data/linkedin/browser-profile` | Playwright persistent context path. Useful for multi-account dev testing |
| `LINKEDIN_THROTTLE_MS` | `2000` | Delay between page navigations |
| `LINKEDIN_SYNC_MESSAGE_CAP` | unlimited | Max threads scraped per sync. Default is unlimited — every thread in your inbox. Set a positive integer (e.g. `50`) to cap for speed. Expect roughly 15 seconds per thread at the default throttle, so 500 threads ≈ 2 hours. The scrape prints a time estimate before starting; Ctrl+C aborts cleanly (prior data preserved). |
| `LINKEDIN_SCRAPE_INVITATIONS` | unset | If `1`, also scrapes pending invitations (sent + received) into `data/linkedin/pending-invitations.json`. **Pending only** — LinkedIn's DOM has no history page, so accepted/declined invites are ZIP-only. Writes a SEPARATE file from the ZIP's Invitations.csv so historical data isn't clobbered. |
| `LINKEDIN_SKIP_DETAILS` | `0` | If `1`, skip per-card detail backfill (faster TTHW, degraded matching) |
| `LINKEDIN_MESSAGE_WINDOW_HOURS` | `24` | On incremental syncs, scrape threads with activity within this many hours of `lastSync` |
| `LINKEDIN_ACCEPT_TOS` | unset | If `1`, bypass typed "I accept" prompt (first run still persists sentinel) |
| `LINKEDIN_SAVE_CREDS` | unset | If `1`, prompt for email/password/TOTP, save to `data/linkedin/credentials.json`, then launch the browser and run auto-login to verify the credentials end-to-end. Equivalent to `npm run linkedin:save-and-verify`. |
| `LINKEDIN_SAVE_CREDS_ONLY` | unset | If `1`, prompt for credentials, save them, and exit without launching the browser. Equivalent to `npm run linkedin:save-creds`. |
| `LINKEDIN_FORGET_CREDS` | unset | If `1`, delete stored credentials and continue. Equivalent to `npm run linkedin:forget-creds`. |
| `LINKEDIN_MANUAL` | unset | If `1`, ignore stored credentials and use the manual-login flow. |
| `LINKEDIN_LIVE_TEST` | unset | If `1`, run live-test suite against real account |
| `MINTY_LINKEDIN_AUTOSYNC` | unset | Feature flag — if unset, all auto-sync endpoints 404 and SPA falls back to ZIP-only |

### Feature flag

The entire auto-sync surface is gated behind `MINTY_LINKEDIN_AUTOSYNC=1`. When unset, the feature's endpoints return 404 and the Sources-view UI falls back to ZIP-only. This is the feature's kill-switch — if you decide not to use it, simply leave this env var unset.

### Security

The persistent browser session lives at `data/linkedin/browser-profile/`. Minty creates this directory with `0700` permissions and refuses to launch if they loosen. Malware running as your user can still impersonate your LinkedIn session indefinitely — disk encryption (FileVault / LUKS / similar) is your first line of defense.

### Deprecation note

`npm run linkedin` has been renamed to `npm run linkedin:import-zip`. The old name still works but prints a deprecation warning and will be removed in v0.4. Update any cron jobs or scripts.

## Privacy

Minty is **offline by default**. The only network traffic:
- WhatsApp importer talks to WhatsApp Web (required for that source)
- Email importer talks to your IMAP / Gmail API (required for that source)
- Optional: Google Calendar API if you opt in to the calendar integration
- Optional: Apollo enrichment (only if you explicitly set `APOLLO_API_KEY`)
- Optional: Ollama (runs locally) or Claude Code CLI (sends prompts to Anthropic's cloud when you invoke an AI pipeline). For fully-offline AI, set `AI_BACKEND=ollama`.

Everything else — contacts, messages, insights, timelines — lives in `data/` on your disk. No telemetry, no analytics, no phone-home. See [SECURITY.md](./SECURITY.md).

## Project structure

For the full guided tour — data flow, invariants, glossary — see [ARCHITECTURE.md](./ARCHITECTURE.md).

```
crm/        # the unified app (HTTP server + SPA, merge, query, AI)
sources/    # one importer per data source
ee/         # reserved for future commercial features
data/       # your local data (gitignored)
docs/       # long-form docs + ADRs
tests/      # unit / integration / e2e
```

## Architecture: AI without API credits

Minty deliberately avoids runtime LLM fees. Two supported backends:

- **Claude Code CLI** (default) — if you have `claude` on your PATH, Minty calls it via `claude --print` for insights and ranking. Free if you're already a Claude user. Note: this backend sends your prompts (which include message snippets from the contacts being analyzed) to Anthropic's servers. Convenient if you trust Anthropic; choose Ollama below if you don't.
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
