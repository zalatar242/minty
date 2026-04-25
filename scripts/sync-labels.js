#!/usr/bin/env node
/**
 * Sync GitHub labels from .github/labels.json using `gh label create --force`.
 *
 * Idempotent — `gh label create --force` updates the label if it already exists.
 * Run after editing .github/labels.json:
 *
 *   npm run labels:sync
 *
 * Requires: gh CLI authenticated to a repo with `issues: write` access.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LABELS_PATH = path.join(__dirname, '..', '.github', 'labels.json');

function main() {
    const labels = JSON.parse(fs.readFileSync(LABELS_PATH, 'utf8'));
    if (!Array.isArray(labels)) {
        console.error('labels.json must be an array');
        process.exit(1);
    }

    const ghCheck = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe' });
    if (ghCheck.status !== 0) {
        console.error('gh CLI is not authenticated. Run `gh auth login` first.');
        process.exit(1);
    }

    let created = 0;
    let failed = 0;
    for (const label of labels) {
        const args = [
            'label', 'create', label.name,
            '--color', label.color,
            '--description', label.description || '',
            '--force',
        ];
        const r = spawnSync('gh', args, { stdio: 'inherit' });
        if (r.status === 0) {
            created += 1;
        } else {
            failed += 1;
        }
    }

    console.log(`\nDone. ${created} synced, ${failed} failed.`);
    process.exit(failed === 0 ? 0 : 1);
}

main();
