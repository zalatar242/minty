'use strict';

/**
 * Seeds a small deterministic dataset into CRM_DATA_DIR before E2E tests
 * so smokes don't depend on the developer's real data.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function seedE2EData() {
    const dir = path.resolve(__dirname, '../../data-e2e');
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    const result = spawnSync(
        process.execPath,
        [path.resolve(__dirname, '../../scripts/seed-dev-data.js'), '--clean'],
        {
            env: { ...process.env, CRM_DATA_DIR: dir },
            stdio: 'inherit',
        },
    );
    if (result.status !== 0) {
        throw new Error('seed-dev-data.js exited with status ' + result.status);
    }
    return dir;
}

module.exports = { seedE2EData };
