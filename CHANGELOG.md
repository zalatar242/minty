# Changelog

All notable changes to Minty will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-04-23

### Fixed
- **People view runaway scroll.** A small scroll on the contacts list could trigger the browser's scroll-anchoring heuristic to fight with the virtual scroller: every `vsRender` DOM swap inside the viewport made the browser re-anchor, overshoot, fire another scroll event, and drive `scrollTop` hundreds or thousands of pixels further than the user scrolled. The list is now annotated with `overflow-anchor: none` so the browser stops trying to pin content during a virtual-scroll render. Rows are also fixed at `height: 64px` (was `min-height`) to keep the virtual scroller's math exact, and the list no longer leaks overscroll to the page.

## [0.3.0] - 2026-04-23

Resilient WhatsApp sync with live, visible progress. The previous exporter held every chat in memory and wrote `chats.json` once at the end — a tab close, memory spike, or server restart on a large account threw away hours of work and left the dashboard empty. Now every chat is saved as it finishes, the first run only pulls 50 messages per chat so big accounts complete in minutes, and a global progress toast follows you across every view while the import runs.

### Added
- **Global WhatsApp sync toast** — a top-right (bottom on mobile) status card shows live progress (`Syncing WhatsApp · 42/580 chats · 4,217 msgs · 7%`) while an import runs, regardless of which view you're on. Tap it to jump to Sources. Turns green and auto-dismisses on completion.
- **`/api/sources/whatsapp/progress`** — read-only endpoint that reflects the on-disk import state. Survives server restarts so the UI can resume showing progress after a reload.

### Changed
- **Incremental WhatsApp export.** Both the in-app connector (`crm/server.js:exportWhatsapp`) and the CLI (`sources/whatsapp/export.js`) now write `chats.json` after every chat instead of only at the end. Partial progress survives crashes and restarts — re-running picks up where it left off and dedupes by message id.
- **Incremental merge during import.** The unified view (`data/unified/contacts.json` and `interactions.json`) now refreshes every 25 chats while a WhatsApp import is in flight, so Today / People / Ask start populating before the full sync finishes.
- **Smaller first-run fetch limit.** First WhatsApp run pulls 50 messages per chat (was 500 in-app, 2000 CLI); subsequent incremental syncs use 500. Big accounts (10k+ contacts) complete the first pass in minutes instead of hanging.
- **Graceful per-chat error handling.** A single broken chat no longer kills the whole import — failures are logged and the loop continues.

### Fixed
- **Live WhatsApp listener** — `exportWhatsapp` no longer destroys the client before the caller attaches the real-time message listener; previously "Live — receiving messages" was attached to a dead Puppeteer instance.

## [0.2.1] - 2026-04-23

### Fixed
- Sources view now shows the correct WhatsApp contact count. The counter was hard-coded to read array-shaped contact files and silently reported `0` for WhatsApp, whose `contacts.json` is keyed by phone ID. All other sources continue to count as before.

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
