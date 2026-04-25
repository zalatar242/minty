# Contributing to Minty

Thanks for your interest in contributing. Minty is maintained by a solo developer, so these rules exist to keep the project sustainable. Please read them before opening an issue or PR.

## Before you open a PR

1. **Open an issue first** for anything non-trivial. Discussion-first avoids wasted work if the idea isn't a fit.
2. **One PR, one topic.** Bundled changes are hard to review and get closed.
3. **Keep the diff small.** < 300 lines is ideal. Larger PRs need a strong reason.
4. **Test what you change.** There's no heavy test suite yet — manual verification is fine, but describe what you checked in the PR body.
5. **No refactor-only PRs** without a prior issue explaining the win. "Cleanup" isn't free for the maintainer.
6. **UI changes: include before/after screenshots.** Minty is a visual product.
7. **Cap of 3 open PRs per contributor.** Keeps queue sane for solo review.

## What we're looking for

- Bug fixes with clear repro steps
- New importers (bring your own data source)
- Matching accuracy improvements (see `crm/match.js` and `crm/MATCHING.md`)
- Performance fixes if you have 10k+ contacts
- Docs/README improvements

## What's out of scope for now

- TypeScript migration — the project is deliberately plain Node.js CJS
- Heavy dependencies (anything > 1MB) — node built-ins preferred
- External LLM API integrations in core — see the "AI without API credits" section in README
- Multi-tenant / SaaS features — those belong in a separate `ee/` track
- Mobile apps, browser extensions

## Licensing

Minty is **AGPL-3.0**. By contributing, you agree your contributions are licensed under AGPL-3.0.

We do **not** use a CLA. If Minty ever offers a commercial license alongside AGPL, it will be through a separate proprietary codebase in `ee/`, not by relicensing community contributions. Your code stays AGPL-3.0, forever.

## Where to start

New here? Read [ARCHITECTURE.md](./ARCHITECTURE.md) first — 10-min tour of the codebase. Then:

- **First time looking for something to do:** filter issues by [`good first issue`](https://github.com/zalatar242/minty/labels/good%20first%20issue) and [`help wanted`](https://github.com/zalatar242/minty/labels/help%20wanted). If none are open, the highest-leverage drive-by fixes are usually: fixing a bug you hit yourself, improving an importer for a source you actually use, or tightening the matcher with a test fixture.
- **Adding a new importer:** see ARCHITECTURE.md → "Where to start as a contributor".
- **Touching matching:** read `crm/MATCHING.md` and add a fixture under `tests/unit/`.

## Development

```bash
git clone https://github.com/zalatar242/minty.git
cd minty
npm install
git config core.hooksPath .githooks   # enables pre-push preflight
npm run crm                            # http://localhost:3456
```

- All data goes in `data/` (gitignored)
- Client JS lives inline in `crm/server.js` (intentional — single-file SPA)
- No build step, no bundler

## Testing

```bash
npm test                  # unit tests (node --test, ~seconds)
npm run test:integration  # integration tests
npm run test:smoke        # Playwright smoke E2E (needs `npx playwright install chromium` first)
npm run test:e2e          # full E2E suite
npm run preflight         # what runs on `git push` — unit + e2e smokes
```

The pre-push hook runs `scripts/preflight.sh` automatically once you've set `core.hooksPath` (above). Bypass with `git push --no-verify` only if you have a reason — CI runs the same checks.

When fixing a bug, add a test that fails before your fix and passes after. When adding a feature, add a test that exercises the happy path. We don't have full coverage and that's fine — we have *enough* coverage to keep the matcher honest and the unified store consistent.

## AI-assisted contributions

AI-assisted PRs are welcome, but:
- **Disclose it** in the PR description
- **You're responsible for the code** — you read it, tested it, stand behind it
- Low-effort AI slop (no testing, no context) will be closed without review

## Code of Conduct

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Response time

Solo maintainer, best-effort. I triage issues weekly. If you haven't heard back in a month, feel free to ping.
