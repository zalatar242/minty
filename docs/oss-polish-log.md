# OSS-polish log

A rolling log of open-source-quality improvements made by an autonomous loop while the maintainer is away. Newest at top.

**Loop status (2026-04-25):** Concrete backlog drained after 12 atomic commits. Loop ended pending maintainer review. Items left under "Needs user" require product judgment or GitHub UI access — not loop-eligible. To resume on a wider mandate (e.g. code review of `crm/server.js` size, performance pass, importer hardening), kick the loop off again with the new scope.

## Shipped

- **2026-04-25** — Added `tests/README.md` orienting contributors who land in the tests folder: layer overview, when-to-add-what table, fixture/PII rules, CI summary. Pattern from Node.js core / Vitest contributor docs.
- **2026-04-25** — Added `.editorconfig` (4-space JS, 2-space JSON/YAML, LF, UTF-8). Keeps whitespace consistent across VSCode/JetBrains/Vim contributors. Standard EditorConfig pattern — borrowed from Excalidraw + Plausible.
- **2026-04-25** — Added `.github/labels.json` (21 labels: workflow, severity, source-area, triage) + `scripts/sync-labels.js` and `npm run labels:sync` so labels are version-controlled and provisionable with `gh label create --force`. Pattern from Probot/`label-sync` ecosystem — declarative JSON > clicking through GitHub UI.
- **2026-04-25** — Slimmed README "Project structure" to a 6-line redirect to ARCHITECTURE.md (was 26 lines duplicating it). Single source of truth.
- **2026-04-25** — Added `docs/adr/README.md` formalising the ADR convention (when to write one, how, status lifecycle, index). Pattern from Michael Nygard's lightweight-ADR template.
- **2026-04-25** — Converted issue templates from `.md` to GitHub's YAML form templates (`.yml`). Required fields, typed inputs, `source` dropdown for importer-bug triage. Pattern from Cal.com / Excalidraw — typed forms catch missing repro info before it hits the maintainer.
- **2026-04-25** — Added live status badges to README: CI status (workflows/ci.yml) + Latest release (auto-updates from GitHub release tags). Pattern from Excalidraw / Plausible — live signals before vanity badges.
- **2026-04-25** — Added `RELEASING.md` documenting versioning policy, cadence, step-by-step cut, and hotfix flow. Borrowed structure from Keep a Changelog ecosystem (Vue.js / Tailwind release docs) — exact CLI commands, no hand-waving.
- **2026-04-25** — Added `.github/CODEOWNERS` (solo maintainer for now) so review routing surfaces in the GitHub UI. Pattern is GitHub's stock CODEOWNERS recommendation.
- **2026-04-25** — Added a "Supported versions" table to `SECURITY.md` (pre-1.0 latest-only policy). Pattern from Keep a Changelog ecosystem + GitHub's security-policy template.
- **2026-04-25** — Deepened `CONTRIBUTING.md`: "Where to start" pointer to ARCHITECTURE.md, `good first issue` guidance, dev-setup with `core.hooksPath`, full Testing section listing every script. Pattern borrowed from Node.js core's CONTRIBUTING (concrete commands over prose) + Excalidraw (explicit "where to start" block).
- **2026-04-25** — Added `.github/dependabot.yml` (weekly, grouped minor+patch into one PR, low PR cap). Borrowed grouping pattern from Plausible/analytics + Standard Notes — keeps the review burden sane for a solo maintainer.
- **2026-04-25** — Added `ARCHITECTURE.md` so newcomers can orient in <10 min. Borrowed structure from [matklad's "ARCHITECTURE.md" pattern](https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html) (bird's-eye → map of code → data flow → invariants → glossary), tailored to Minty's actual layout.

## Needs user (human judgment / GitHub UI)

These are queued for a human because they need taste calls or repo-admin access:

- **Hero screenshot/GIF in README.** The README has a TODO comment where a real screenshot/GIF of the contact list + detail view should go. Record at v0.3.x and drop into `docs/hero.png` (or `.gif`); the README placeholder already points there.
- **GitHub repo metadata.** The repo description and topics are set via the GitHub UI, not the codebase. Suggested topics (high-signal for discovery): `personal-crm`, `prm`, `self-hosted`, `privacy`, `local-first`, `whatsapp`, `gmail`, `linkedin`, `telegram`, `nodejs`, `agpl`. Suggested description matches `package.json`: *"Privacy-first personal CRM — unifies WhatsApp, Gmail, LinkedIn, Telegram, SMS, and Google Contacts locally. Surfaces who you should reach out to, and why."*
- **GitHub labels — provision them.** Labels are now declarative in `.github/labels.json`. Run `npm run labels:sync` once (needs `gh auth login`) to create them all on the repo. Edit the JSON and re-run to add/rename later.

- **ROADMAP.md is stale.** It's dated `v0.2.x — April 2026` but `package.json` is at `0.3.2` and the `Now` section lists items already shipped (CI, dependabot vuln triage, etc.). Needs a maintainer pass to mark items shipped, retitle the section to `v0.3.x`, and refresh `Next` / `Later`.

- **README "How is this different from X?" comparison.** Personal-CRM space is crowded (Monica, Cardhop, Dex, Clay, Folk). A short comparison table — even 4 rows — would help discovery and positioning, but it's a product-judgment call (which competitors to mention, what to claim about them).

- **`.github/FUNDING.yml`.** Not added unilaterally — needs a sponsor URL (GitHub Sponsors, Open Collective, Buy Me A Coffee) and the maintainer's call on whether to solicit at all this early. If desired, reply with the sponsor URL and one will be added in one commit.

- **ADR 0001 status.** Currently `Proposed`. If the WhatsApp-library decision is final, flip to `Accepted` and update the date. If still being weighed, leave as is.

- **README hero screenshot/GIF.** README has a TODO comment where a real screenshot/GIF of the contact list + detail view should go. Record at v0.3.x and drop into `docs/hero.png` (or `.gif`); the placeholder already points there.

- **GitHub repo metadata** (description + topics) — set via the GitHub UI, not the codebase. Suggested topics: `personal-crm`, `prm`, `self-hosted`, `privacy`, `local-first`, `whatsapp`, `gmail`, `linkedin`, `telegram`, `nodejs`, `agpl`. Suggested description matches `package.json`: *"Privacy-first personal CRM — unifies WhatsApp, Gmail, LinkedIn, Telegram, SMS, and Google Contacts locally. Surfaces who you should reach out to, and why."*
