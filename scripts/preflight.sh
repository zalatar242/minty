#!/usr/bin/env bash
# scripts/preflight.sh - run before pushing to catch the obvious stuff fast.
# Skips E2E if Playwright's Chromium isn't installed, so it stays usable on a
# fresh checkout without ceremony.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> unit tests"
npm test --silent

# Run E2E only when BOTH the npm package and the browser cache are present.
# Either one missing = skip cleanly. (Browser cache alone is not enough — a
# shared cache from another checkout doesn't imply this one ran `npm install`.)
have_pkg=0
[ -d "$ROOT/node_modules/@playwright/test" ] && have_pkg=1
have_browser=0
if [ -d "$HOME/.cache/ms-playwright" ] || [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
    have_browser=1
fi

if [ "$have_pkg" = "1" ] && [ "$have_browser" = "1" ]; then
    echo "==> e2e smokes"
    npx playwright test --reporter=line
elif [ "$have_pkg" = "0" ]; then
    echo "==> e2e smokes (skipped: run 'npm install')"
else
    echo "==> e2e smokes (skipped: run 'npx playwright install chromium')"
fi

echo "==> preflight ok"
