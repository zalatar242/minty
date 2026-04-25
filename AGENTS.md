# AGENTS.md — Working on Minty with AI Assistance

Minty is built to be worked on with AI coding agents (Claude Code, Cursor, Codex, Aider, etc.). This file is the agent-readable brief. If you're a human contributor, [CONTRIBUTING.md](./CONTRIBUTING.md) covers the same ground in human terms — read that first.

If you're an agent, read this file fully before writing any code. It's the contract between you and the project.

---

## What Minty is

Minty is a **self-hosted personal CRM** (PRM) that unifies WhatsApp, Gmail, LinkedIn, Telegram, SMS, and Google Contacts locally. It is **not** a tool for "staying in touch." It's a tool for **activating your network toward specific goals**: a fundraise, a hire, a market entry, an introduction. See [docs/PHILOSOPHY.md](./docs/PHILOSOPHY.md) for the full product thinking — read it, because it changes which features are "right" vs "wrong" to implement.

**Right:** "I need to raise a seed round — who in my network can actually help?"
**Wrong:** "You haven't spoken to Sarah in 60 days — reach out."

Every feature must pass the test: *"Does this help the user activate their network toward a specific goal?"* If it just nudges them to talk to more people for maintenance's sake — cut it or reframe it.

---

## Architecture rules

- **All API routes** live in `crm/server.js`
- **All data transforms / computations** go in `crm/merge.js` or a new `crm/[feature].js`
- **Client-side JS** lives inline in the HTML template in `server.js` (single-file SPA — known debt, *reduce* don't grow)
- **Data** lives in `data/unified/` — `contacts.json`, `interactions.json`, `insights.json`, `digest.json`
- **Sync state** lives in `data/sync-state.json`
- **No TypeScript** — plain Node.js CommonJS only
- **Minimise npm dependencies** — Node built-ins first
- **No runtime LLM API calls** — see "AI without API credits" below

Feel free to refactor aggressively when it improves the product. Don't be timid. Just don't change conventions without reason.

---

## AI without API credits

The AI that runs in Minty is *you* (or whatever LLM the user has configured via `AI_BACKEND`). Minty pre-computes insights during batch runs and caches them to JSON. The web server reads those static files. There are no runtime API calls.

When a feature needs intelligence (e.g. weekly digest, reconnect drafts, query ranking):

1. Read the relevant data files in `data/unified/`
2. Synthesize the result
3. Write it to a JSON file (e.g. `data/unified/insights.json`)
4. The UI reads the cached file — zero runtime inference

This means AI work happens once per scheduled run, and the product stays free to host.

---

## Before you write any code

1. **Run `npm test`** — confirm the baseline is green before touching anything
2. **Read `docs/PHILOSOPHY.md`** if you haven't already — product direction is non-negotiable
3. **Think like a senior engineer who cares about craft:**
   - Does this implementation actually solve the user's problem?
   - Is this the simplest version that delivers real value?
   - Would a thoughtful user find this beautiful and useful?
4. **Search the web for relevant patterns** — 2-3 targeted queries. Look at what the best products do.

## After you write code

1. **Write tests** for every new pure function (in `tests/unit/`) and every new API route (integration test if applicable)
2. **Run `npm test`** again — ALL tests must pass before committing. If a test fails, fix the code, not the test (unless the test itself is wrong)
3. **Run `npm run test:e2e`** if you touched routes, the SPA, or anything user-facing. Smokes live in `tests/e2e/` and seed `data-e2e/` automatically. Six smokes should pass in ~2s.
4. **Verify the UI** — no JS errors in the browser console, API returns sensible data. The Chrome DevTools MCP is wired in `.mcp.json`, so you can ask the agent to drive a real browser instead of guessing.
5. **Commit with a clear message**: `feat: [description]`, `fix: [description]`, `refactor: [description]`
6. **One PR = one topic.** Bundled PRs get closed (see CONTRIBUTING.md)
7. **Push runs preflight automatically** (lint + unit + e2e) via `.githooks/pre-push`. Bypass with `--no-verify` only when you have a reason.

---

## Codebase quick reference

**Core modules** (in `crm/`):
- `server.js` — HTTP server + full SPA HTML/CSS/JS (large — reduce, don't grow)
- `schema.js` — `createContact()` and `createInteraction()` data shapes
- `merge.js` — contact merge pipeline (dedup, stable IDs)
- `match.js` — cross-source matching heuristics
- `utils.js` — pure utils: `normalizePhone`, `normalizeEmail`, `normalizeName`, `phoneKey`, `relationshipScore`, `ContactIndex`
- `ai.js` — AI backend abstraction (`claude --print` or `ollama`)
- `sync.js` — background sync daemon
- `analyze.js` — batch insight synthesis
- `digest.js` — weekly digest builder
- `network-query.js` — natural-language query parser
- `reconnect.js` — reconnect draft templates
- `calendar.js` — Google Calendar integration
- `staleness.js` — data-freshness detection
- `index.js` — network query index builder (one-shot)

**Data shapes (contacts):**
- `id, name, phones[], emails[], notes, tags[], sources{whatsapp, linkedin, telegram, email, googleContacts, sms}`
- `lastContactedAt, createdAt, updatedAt`
- `relationshipScore, daysSinceContact, interactionCount, activeChannels[]`
- `isGroup` (true for WhatsApp group chats; excluded from scoring)
- `apollo{location, headline, twitterUrl, employmentHistory[]}`
- `notes` may contain `score_override:N` prefix

**Data shapes (insights.json, keyed by contactId):**
- `topics: string[]`
- `openLoops: string[]`
- `sentiment: "positive" | "neutral" | "negative"`
- `meetingBrief: string`
- `reconnectDraft: string`
- `analyzedAt: ISO`

**Test layout:**
- `tests/unit/[module].test.js` — pure functions, no server, no files
- `tests/integration/[feature].test.js` — HTTP endpoints, real server
- `tests/helpers/fixtures.js` — synthetic data (**no real user data, ever**)

Use Node's built-in test runner: `npm test`.

---

## Design system

Internalize this. Minty leads with the person, not the data.

**Colors:**
```
--bg:             #0a0d14   (background)
--bg-card:        #111827   (cards)
--bg-hover:       #1a2235   (hover)
--border:         #1e2d45   (borders)
--text-primary:   #f0f4ff   (names, headings)
--text-secondary: #8892a4   (metadata)
--text-muted:     #4b5563   (timestamps, labels)
--health-strong:  #22c55e   (green — strong relationship)
--health-good:    #84cc16   (lime)
--health-warm:    #f59e0b   (amber)
--health-fading:  #f97316   (orange)
--health-cold:    #ef4444   (red)
--health-none:    #374151   (gray — never contacted)
--accent:         #6366f1   (indigo — interactive)
--accent-hover:   #818cf8
```

**Typography:**
- Contact names: 15px, font-weight 500, letter-spacing -0.02em
- Company names: 11px, uppercase, letter-spacing 0.06em, `--text-muted`
- Timestamps: 12px, `--text-muted`, tabular-nums
- Section headers: 11px, uppercase, letter-spacing 0.1em, font-weight 600, `--text-muted`

**Interactions:**
- Hover transitions: 180ms ease
- Contact row hover: `background: --bg-hover; transform: translateX(2px)`
- Card hover: subtle shadow + accent-tinted border

**UI philosophy (Jony Ive — internalize):**
- Every element earns its place. If it doesn't help the user understand or act — remove it.
- Lead with the person, not the data. Avatars first. Names big. Data small and secondary.
- One primary action per view. Don't overwhelm with choices.
- Time is the primary dimension. Express everything in human terms: "3 days ago", not "2026-03-12".
- Relationships are warm. The UI should feel warm. Not clinical. Not database-y.

---

## Quality bar (before marking anything done)

- [ ] `npm test` passes — all tests green
- [ ] New code has tests covering core behavior and edge cases
- [ ] UI renders without JS errors (check browser console)
- [ ] API endpoints return sensible data for a known contact
- [ ] The feature is actually useful — would a real user open this daily?
- [ ] Code follows existing patterns (don't introduce new conventions without reason)
- [ ] Committed with a clear, professional message
- [ ] If you touched existing views: visually verify no regressions

## Mindset

Think like a senior engineer who cares deeply about user experience. Don't just implement the spec — read it, understand the *why*, then implement the best version. If the spec says to do X but you see a better way to achieve the goal, do it and note why.

The goal is a product that feels alive, trustworthy, and beautiful — not a list of checked boxes.
