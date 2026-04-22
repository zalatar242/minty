# Vision

## Today

Minty is a **self-hosted, privacy-first personal CRM**. You import your own data from WhatsApp, Gmail, LinkedIn, Telegram, SMS, and Google Contacts; everything gets deduplicated into one unified view; you search and browse it locally in a web UI at `localhost:3456`. No accounts, no cloud, no API fees.

The core loop is:
1. **Import** — pull data from sources you already use
2. **Merge** — cross-source deduplication collapses a person into a single record
3. **Browse** — unified contact list + per-contact timeline

## Where it's going

### Near term (v0.x)
- **Better matching accuracy** — more signals, more heuristics, learned overrides
- **More sources** — Discord, iMessage, Slack DMs
- **Richer timeline** — attachments, link previews, inline reactions
- **CLI parity** — everything the web UI does, available from the terminal

### Medium term (v1.x)
- **Local AI layer** — bring-your-own-LLM for relationship summaries, "who should I follow up with" suggestions. Runs against local JSON, no data leaves.
- **Calendar integration** — cross-reference upcoming meetings with contact history
- **Natural language search** — "who did I meet at that conference in March"
- **Stale data detection** — warn when a contact hasn't been updated from any source in a year

### Long term
- **Goal-oriented UX** — the core bet is that a CRM shouldn't be a maintenance tool ("keep relationships warm"), it should be a goal-achievement tool ("help me find an intro to X via my network")
- **Graph-level features** — shortest-path intro finding, company clustering, network-wide queries
- **Collaborative editing** — trusted contacts can update their own records (e2e encrypted)

## Non-goals

- **SaaS core.** Minty runs on your machine. If there's ever a hosted version, it'll be in a separate `ee/` directory under a commercial license — the free self-hosted experience stays complete.
- **External LLM API calls at runtime.** We don't want to silently spend your money or send your data to OpenAI/Anthropic without explicit opt-in.
- **TypeScript.** Plain Node.js CJS, minimal dependencies, zero build step.
- **Mobile / browser extension.** Desktop web UI only for v1.
- **Replacing LinkedIn.** Minty is a personal tool, not a social network.

## Why open source

Two reasons:
1. **Your data should be yours.** Closed-source personal CRMs are fundamentally at odds with that principle — you can't audit what they do with your contacts.
2. **The moat isn't the code.** The moat is execution, UX polish, and — eventually — a great hosted version for people who don't want to self-host. The code itself is more valuable open than closed.

If you fork Minty and build something great, genuinely: good. That's the point.
