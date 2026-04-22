# Changelog

All notable changes to Minty will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - TBD

First major feature drop. Relationship-intelligence features land: goal-oriented home view, natural-language network query, reconnect composer, calendar integration, stale data detection, mobile-responsive layout, and a background sync daemon. Test suite added.

### Added
- **Goal-oriented "Today" home view** — surfaces who can help you *now*, not who to maintain
- **Ask view** — natural-language network query with instant filter + AI-ranked results ("who works at <company>", "who did I meet in March")
- **Reconnect message composer** — context-aware pre-generated drafts for fading relationships
- **Google Calendar integration** — auto meeting prep with contact cross-reference
- **Stale data warnings** — proactive alerts when a contact hasn't been updated in 12+ months
- **Background sync daemon** — live WhatsApp, incremental Gmail, file watchers
- **In-app Sources view** — connect Gmail / Google Contacts via OAuth, drag-and-drop imports for LinkedIn / Telegram / SMS
- **Mobile-responsive layout** — bottom nav, touch targets, full-screen views on phones
- **AI backend abstraction** (`crm/ai.js`) — pluggable Claude Code CLI or Ollama, no external API fees
- **Weekly digest** (`npm run digest`) — AI-synthesized recap of your network activity
- **Network query index builder** (`npm run index`) — pre-computes `data/unified/query-index.json`
- **Contact insights pipeline** (`npm run analyze`) — batch AI synthesis into `data/unified/insights.json`
- **Health rings / relationship visualization** — avatar-forward list view with virtual scroll
- **Groups view** — WhatsApp group chats analysed and categorized
- **Cross-source intro finder** — graph-based shortest-path intro suggestions
- **Company clustering / industry classifier** — network-wide visualizations
- **Unit test suite** — `npm test` runs the Node built-in test runner across 12+ modules
- First-run bootstrap — auto-creates empty `data/unified/` so a fresh `npm run crm` boots cleanly

### Changed
- `server.js` grew from 951 → ~4k lines (after stripping the multi-tenant layer)
- Client SPA redesigned with a contact-list virtual scroll, goal view, sources view, network map, and Ask view

### Security
- Tightened input validation on upload endpoints (multipart body size caps, extension allow-lists)

## [0.1.0] - 2026-04-22

Initial public release.

### Added
- Web UI at `localhost:3456` (`npm run crm`) — contact list, contact detail, match review
- Importers: WhatsApp, LinkedIn, Telegram, Email (IMAP), Google Contacts, SMS, Apollo enrichment
- Cross-source dedup and merge engine (`crm/merge.js`)
- Matching engine with stable ID derivation (`crm/match.js`)
- CLI query tools (`npm run stats`, `npm run search`)
- Match review server (`npm run review`)

[Unreleased]: https://github.com/zalatar242/minty/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zalatar242/minty/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zalatar242/minty/releases/tag/v0.1.0
