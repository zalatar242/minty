#!/usr/bin/env bash
# scripts/preflight.sh - run before pushing to catch the obvious stuff fast.
# Skips E2E if Playwright's Chromium isn't installed, so it stays usable on a
# fresh checkout without ceremony.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> unit tests"
npm test --silent

if [ -d "$HOME/.cache/ms-playwright" ] || [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
    echo "==> e2e smokes"
    npx playwright test --reporter=line
else
    echo "==> e2e smokes (skipped: run 'npx playwright install chromium')"
fi

echo "==> preflight ok"
