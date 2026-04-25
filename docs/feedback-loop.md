# Feedback loop

Tools wired into this repo so bugs get caught earlier and faster. Keep this doc up to date when you change the loop.

## Inner loop (while coding)

**Chrome DevTools MCP + Playwright MCP** are configured in `.mcp.json`. Any Claude Code session opened in this repo can drive a real Chrome, inspect DOM, read console errors, take screenshots, and run perf traces. Chrome DevTools MCP is the lighter option for ad-hoc debugging; Playwright MCP is heavier but better when you want the agent to author a durable test.

No global setup needed. The MCP servers are launched on demand by `npx`.

## Tests

| Layer | Where | Run with |
| --- | --- | --- |
| Unit | `tests/unit/` | `npm test` |
| Integration | `tests/integration/` | `npm run test:integration` |
| E2E API + browser | `tests/e2e/*.spec.js` | `npm run test:e2e` |
| Stagehand UI smoke | `tests/e2e/ui-smoke.stagehand.js` | `node tests/e2e/ui-smoke.stagehand.js` |
| Tag-filtered smokes | grep `@smoke` | `npm run test:smoke` |

E2E auto-seeds `data-e2e/` via `scripts/seed-dev-data.js` on every run, so smokes never depend on personal data.

The Stagehand smoke is opt-in. It needs `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) and skips silently if neither is set. Use it when you want to verify a flow described in plain English ("open the app, search for 'sam', see results"). It is intentionally not part of `preflight` because it costs API calls.

## Preflight + git hook

```
npm run hooks:install   # one-time, sets core.hooksPath to .githooks
npm run preflight       # runs lint + unit + e2e
```

The pre-push hook runs preflight automatically. Override with `git push --no-verify` only when you have a reason. E2E is skipped if Playwright's Chromium isn't installed locally, so the hook stays usable on a fresh checkout.

## CI

- `.github/workflows/ci.yml` runs unit + integration on Node 20 and 22, three OSes.
- `.github/workflows/e2e.yml` runs Playwright smokes on Linux Node 20. Failed runs upload `playwright-report/` and `test-results/` as artifacts for 7 days.
- `.github/workflows/codeql.yml` runs CodeQL security analysis.
- `.github/workflows/dependency-review.yml` blocks PRs that introduce vulnerable dependencies.

## Error monitoring (optional)

Off by default. Set `MINTY_ERROR_DSN` to a Sentry-protocol URL to enable. The DSN format works with self-hosted GlitchTip too, which keeps Minty's privacy posture consistent end to end.

```
export MINTY_ERROR_DSN='https://<key>@your-host/<project>'
export MINTY_ERROR_RELEASE='v0.3.2'        # optional, tags events
export MINTY_ERROR_ENV='production'         # optional, defaults to NODE_ENV
npm run crm
```

`crm/observability.js` scrubs cookies, query strings, request bodies, and any header starting with `x-` before sending. It does not capture user emails or IPs. Sample rate for traces is 0.

### Self-hosting GlitchTip

Recommended for Minty since the rest of the stack is self-hosted. One-machine compose:

```yaml
# glitchtip/compose.yml (not in repo, write where you host it)
version: "3"
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: glitchtip
      POSTGRES_USER: glitchtip
      POSTGRES_PASSWORD: glitchtip
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7
  web:
    image: glitchtip/glitchtip
    depends_on: [postgres, redis]
    environment:
      DATABASE_URL: postgres://glitchtip:glitchtip@postgres:5432/glitchtip
      SECRET_KEY: replace-me
      PORT: 8000
      EMAIL_URL: consolemail://
      GLITCHTIP_DOMAIN: http://localhost:8000
    ports: ["8000:8000"]
  worker:
    image: glitchtip/glitchtip
    depends_on: [postgres, redis]
    command: ./bin/run-celery-with-beat.sh
    environment:
      DATABASE_URL: postgres://glitchtip:glitchtip@postgres:5432/glitchtip
      SECRET_KEY: replace-me
      EMAIL_URL: consolemail://
      GLITCHTIP_DOMAIN: http://localhost:8000
volumes:
  pgdata:
```

`docker compose up -d`, create a project in the GlitchTip web UI, copy the DSN into `MINTY_ERROR_DSN`. SECRET_KEY should be a real secret, not the placeholder.

## Code review (external)

Install **CodeRabbit** on `zalatar242/minty`:

1. Visit https://github.com/apps/coderabbitai
2. Click Install, choose "Only select repositories", pick `minty`.
3. CodeRabbit posts a review on every PR. Free for public OSS repos (AGPL qualifies).

Alternatives if CodeRabbit isn't a fit: Greptile, Macroscope. Pick one, not three.

## What we deliberately skipped

- **Vendor E2E platforms** (Momentic, Octomind, QA Wolf): Stagehand + Playwright covers the surface for a one-person project. Revisit if maintenance pain shows up.
- **Visual regression** (Percy, Chromatic): not worth the noise until the UI is stable enough to protect.
- **Session replay** (PostHog, FullStory): conflicts with privacy-first positioning unless opt-in. Skipped.
- **TestSprite**: overlaps with what Stagehand + unit tests cover already.
