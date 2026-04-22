# Roadmap

This is the short, public-facing roadmap. For the deeper "why" behind Minty's direction, see [docs/PHILOSOPHY.md](./docs/PHILOSOPHY.md) and [VISION.md](./VISION.md).

Dates are directional, not promises. Priorities shift with real user feedback.

---

## Now (v0.2.x — April 2026)

- 🐞 Bug triage and stability — real-user issues are priority over new features
- 📸 Better screenshots + a demo GIF in the README
- 📦 Address the 8 transitive dependabot vulnerabilities flagged by GitHub
- ⚙️ Smoke-test CI (GitHub Actions) running `npm test` on every PR
- 📝 More code comments / inline docs on the new feature modules

## Next (v0.3 — Summer 2026)

- 🔗 **Discord importer** — DMs + direct group messages
- 💬 **iMessage importer** (macOS) — reads from the local Messages database
- 🎯 **Matching accuracy v2** — learned overrides, fuzzy last-name handling, better cross-source scoring
- 🧠 **Local LLM default** — bundle Ollama + qwen2.5 as the default AI backend (no Claude CLI required)
- 📱 **Mobile-first polish** — the layout is responsive today, but mobile deserves dedicated UX work
- 🧪 **Integration test suite** — real-HTTP tests alongside the existing unit suite

## Later (v0.4 – v1.0)

- 🪟 **Desktop app wrapper** — Tauri or Electron for one-click install
- 🌐 **Browser extension** — capture conversation context as you browse LinkedIn / email
- 🔍 **Full-text search** (SQLite FTS5) — replaces the in-memory index once datasets get large
- 🎨 **Plugin API** for custom data sources — standardised importer interface
- 🌍 **i18n** — UI translations, non-English name/phone matching
- ⚡ **Performance at scale** — tuned for 20k+ contacts without UX regressions
- 📊 **Shared network overlays** — optional, opt-in comparison with a trusted peer's graph

## Commercial (ee/ — TBD)

Reserved for future hosted / enterprise features under a separate commercial license. See [ee/README.md](./ee/README.md).

Candidates:
- Multi-tenant auth (was in the pre-OSS codebase; removed from public)
- SSO/SAML
- Team admin, audit logs, RBAC
- Hosted SaaS at `minty.app` (domain TBD)

---

## Out of scope (not coming, by design)

These are explicit non-goals. See [VISION.md](./VISION.md) for the longer list.

- Social media tracking (Twitter/Instagram follows)
- Paid third-party contact enrichment as a core feature
- Team / shared CRM (multiple users editing one graph)
- Outreach automation or bulk messaging
- TypeScript migration
- External runtime LLM API calls in the core product

---

## Want to help?

Priorities move in response to actual users. Open an issue with a concrete use case — that's more valuable than a "+1" on a GitHub Projects board. See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR.
