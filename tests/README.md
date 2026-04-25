# Tests

Three layers, all live here.

```
tests/
├── unit/         # node --test, runs in seconds, no I/O
├── integration/  # node --test, hits real-but-stubbed boundaries
├── e2e/          # Playwright, drives the real SPA
└── helpers/      # shared fixtures
```

## Running them

```bash
npm test                  # unit + integration (single concurrency)
npm run test:integration  # integration only
npm run test:e2e          # full Playwright run
npm run test:smoke        # @smoke-tagged Playwright tests only (~2s)
npm run preflight         # what the pre-push hook runs: unit + e2e smokes
```

The pre-push hook (`.githooks/pre-push`) auto-skips E2E if Playwright's Chromium isn't installed, so a fresh checkout doesn't have to install browsers to push.

## When to add what

| Change | Add a test in… |
|---|---|
| New pure function in `crm/utils.js`, `crm/match.js`, etc. | `tests/unit/` |
| New API route in `crm/server.js` | `tests/integration/` (or `tests/unit/` if logic is well-isolated) |
| New importer in `sources/` | `tests/unit/` for parsers; `tests/integration/` for fetchers |
| New UI flow visible to the user | `tests/e2e/` Playwright spec, tagged `@smoke` if it's golden-path |
| Bug fix | A failing test that exposes the bug, plus the fix |

The matcher is the most-tested module — copy `tests/unit/match.test.js` patterns when extending it.

## Fixtures

Shared fixtures live in `tests/helpers/fixtures.js`. **Never** commit real personal data — names, phone numbers, emails. Use placeholders like `Alice Example`, `+15550100`, `alice@example.com` (see RFC-2606 for the example domain).

E2E tests seed a fresh `data-e2e/` directory via `tests/e2e/global-setup.js` — that directory is gitignored.

## CI

`.github/workflows/ci.yml` runs `npm test` + smokes on every PR against `main`, on Node 20/22, on Linux/macOS/Windows. The release workflow re-runs the matrix on tag push.
