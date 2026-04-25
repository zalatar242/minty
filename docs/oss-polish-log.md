# OSS-polish log

A rolling log of open-source-quality improvements made by an autonomous loop while the maintainer is away. Newest at top.

## Shipped

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
- **GitHub labels for triage.** Create labels: `good first issue`, `help wanted`, `bug`, `enhancement`, `docs`, `importer/<name>` per source. The CONTRIBUTING.md update will reference `good first issue` and `help wanted` once they exist.
