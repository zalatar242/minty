# Architecture

A 10-minute tour for new contributors. If you want the *why* behind the design choices, read [VISION.md](./VISION.md) and [docs/PHILOSOPHY.md](./docs/PHILOSOPHY.md). If you want the *what* of the matching algorithm specifically, read [crm/MATCHING.md](./crm/MATCHING.md).

This doc is loosely modelled on [matklad's "ARCHITECTURE.md" pattern](https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html): bird's-eye view, map of code, data flow, invariants, glossary.

## Bird's-eye view

Minty is a **single-process Node.js app** that pulls personal data from many sources (WhatsApp, Gmail, LinkedIn, Telegram, SMS, Google Contacts) into one **local JSON store**, deduplicates contacts across sources, builds a unified interaction timeline, and serves a web UI on `localhost:3456`.

Everything runs on one machine. No database server, no cloud, no auth — the **filesystem is the database** and the **OS user is the auth boundary**. AI features call out to a *local* Claude Code CLI or a *local* Ollama model; there is no first-party cloud LLM integration in core (see CONTRIBUTING.md "out of scope").

The whole stack is plain CommonJS. No build step, no bundler, no transpiler. Client JS lives inline in `crm/server.js`. This is deliberate — see VISION.md.

## Map of code

```
minty/
├── crm/                    # The unified app: web server, merge, query, AI
├── sources/                # One subdirectory per data source ("importer")
├── ee/                     # Reserved for future commercial code (currently a stub)
├── data/                   # Runtime data — gitignored; see "Data layout" below
├── docs/                   # Long-form docs and ADRs
├── scripts/                # One-off scripts (preflight, fixtures, seed, export)
├── tests/                  # unit / integration / e2e
└── .githooks/, .github/    # OSS plumbing
```

### `crm/` — the application

This is one process. The pieces:

| File | Role |
|---|---|
| `server.js` | HTTP server + the entire SPA (HTML/CSS/JS inline). Largest file by far; intentional. |
| `merge.js` | Loads per-source data, normalises, dedups, writes `data/unified/contacts.json` and `interactions.json`. |
| `match.js` | Cross-source matching algorithm. Reads MATCHING.md for the spec. |
| `schema.js` | Canonical record shapes for `Contact` and `Interaction`. Start here. |
| `query.js` | CLI: `npm run stats`, `npm run search`. |
| `network-query.js` | Natural-language "Ask" view ("who did I meet at…"). |
| `reconnect.js` | "People fading away" surface + draft generation. |
| `ai.js` | Adapter for local Claude Code CLI / local Ollama. No cloud APIs. |
| `staleness.js` | Marks stale contact data so the UI can warn. |
| `sync.js` | Watches `data/<source>/export/` for user-dropped ZIPs and triggers importers. |
| `calendar.js`, `digest.js`, `meeting-debrief.js`, `goal-retro.js`, `life-events.js` | Higher-level surfaces built on top of the unified store. |
| `utils.js` | Phone/email/name normalisation, scoring helpers, in-memory contact index. |

If you're touching the data model, edit `schema.js` first; the rest follows.

### `sources/` — the importers

Each source is independent and writes to `data/<source>/`. The unified store is rebuilt by `crm/merge.js` from these per-source files — importers never touch `data/unified/`.

| Source | Entry point | Mode |
|---|---|---|
| WhatsApp | `sources/whatsapp/export.js` | Live (whatsapp-web.js, QR pairing, incremental) |
| Gmail / Email | `sources/email/import.js` | OAuth, incremental |
| LinkedIn (ZIP) | `sources/linkedin/import.js` | One-shot, official data export |
| LinkedIn (sync) | `sources/linkedin/connect.js` + `fetch.js` | Opt-in, ToS-adjacent, headful login → headless reuse |
| Telegram | `sources/telegram/import.js` | One-shot, JSON export |
| SMS | `sources/sms/import.js` | One-shot, platform export |
| Google Contacts | `sources/google-contacts/import.js` | OAuth, incremental |
| Apollo (enrichment) | `sources/apollo/enrich.js` | Optional |

Shared importer helpers live in `sources/_shared/`.

### `data/` — runtime layout (gitignored)

```
data/
├── whatsapp/      chats.json, contacts.json, metadata.json, profile_pics/
├── linkedin/      export/  (user-dropped ZIPs)  + parsed CSVs
├── telegram/      result.json + parsed
├── email/         per-account folders
├── sms/           per-platform folders
├── google-contacts/
└── unified/       contacts.json, interactions.json, match_overrides.json  ← the merged view
```

Override roots with `CRM_DATA_DIR` (and per-importer `*_EXPORT_DIR`).

## Data flow

The lifecycle of a contact, end to end:

```
 ┌────────────────┐    ┌─────────────────────┐    ┌──────────────────────┐
 │ user runs an   │ →  │ source importer     │ →  │ data/<source>/*.json │
 │ importer       │    │ (sources/<src>/…)   │    │ (per-source records) │
 └────────────────┘    └─────────────────────┘    └──────────────────────┘
                                                           │
                                                           ▼
                  ┌────────────────────────────────────────────────────┐
                  │ crm/merge.js                                        │
                  │  - normalise phones/emails/names                    │
                  │  - cross-source dedup (crm/match.js, MATCHING.md)   │
                  │  - build unified interaction timeline               │
                  └────────────────────────────────────────────────────┘
                                                           │
                                                           ▼
                                       ┌─────────────────────────────────────┐
                                       │ data/unified/contacts.json          │
                                       │ data/unified/interactions.json      │
                                       └─────────────────────────────────────┘
                                                           │
                                                           ▼
                  ┌────────────────────────────────────────────────────┐
                  │ crm/server.js (HTTP + SPA)                          │
                  │  - serves the UI on :3456                           │
                  │  - reads unified store on each request              │
                  │  - calls ai.js, network-query.js, reconnect.js, …   │
                  └────────────────────────────────────────────────────┘
```

`crm/sync.js` runs in-process inside `server.js` and watches `data/<source>/export/` for user-dropped exports, triggering the right importer and re-running merge automatically.

## Key invariants

These are load-bearing. Break one and something breaks somewhere far away.

1. **Local-first, always.** No data leaves the machine in core. Anything that reaches the network in core (LinkedIn auto-sync, AI inference) is opt-in and routed through a documented adapter.
2. **The filesystem is the database.** All persisted state lives under `data/`. Anything else (e.g. `.wwebjs_auth/`) is a credential cache, not data.
3. **Importers don't talk to importers.** They write to `data/<source>/` and stop. The unified store is the only cross-source surface, and only `crm/merge.js` writes to it.
4. **Contact IDs are stable.** `c_001`, `c_002`, … assigned in `merge.js` and persisted across re-merges via `match_overrides.json`.
5. **AGPL applies to all of `crm/` and `sources/`.** Future commercial code lives in `ee/`. Community contributions stay AGPL forever — see CONTRIBUTING.md.
6. **No TypeScript, no build step.** Plain CJS. New deps must justify their weight (CONTRIBUTING.md "out of scope").
7. **No real personal data in the repo.** Tests use fixtures under `tests/`. The PR template enforces this.

## Glossary

- **Source** — one of WhatsApp, Gmail, etc. Lives in `sources/<name>/`. Owns its own subdirectory of `data/`.
- **Importer** — the entry-point script for a source. Reads from the source's data export (or live API) and writes per-source JSON.
- **Unified store** — `data/unified/contacts.json` + `interactions.json`. The merged, deduplicated view. Read-only outside `crm/merge.js`.
- **Contact** — one person. Has a stable id (`c_NNN`), best-known name/phones/emails, and a `sources` map keyed by source name. Schema in `crm/schema.js`.
- **Interaction** — one message/event with a contact, in any source. Channels into the unified timeline.
- **Match override** — a manual or algorithmic decision that two source-records belong to the same Contact. Persisted in `data/unified/match_overrides.json`.
- **Auto-sync** (LinkedIn) — the opt-in, ToS-adjacent live scraper. Off by default. Gated by `MINTY_LINKEDIN_AUTOSYNC=1`.

## Where to start as a contributor

- **Adding a new importer:** copy one of the simpler ones (`sources/telegram/import.js`) and follow its file layout. Write to `data/<your-source>/`, then add a merge step in `crm/merge.js`.
- **Improving matching:** read `crm/MATCHING.md`, then change `crm/match.js`. Add a fixture to `tests/`.
- **UI work:** everything is in `crm/server.js`. Inline JS, inline CSS, by design. Hot-reload by restarting `npm run crm`.
- **Performance on large datasets:** the merge path is the usual bottleneck. `tests/integration/` has fixture-based perf tests.
