'use strict';

/**
 * Child helper for linkedin-lock tests.
 *
 * Usage:
 *   node lock-child.js <lockPath> <mode>
 *
 * Modes:
 *   hold  — acquire the lock, print "ACQUIRED" to stdout, sleep 3s, release, exit 0
 *   die   — acquire the lock, print "ACQUIRED", then hard-exit(1) without releasing
 */

const { acquireLock } = require('../../../sources/linkedin/lock');

const lockPath = process.argv[2];
const mode = process.argv[3] || 'hold';

if (!lockPath) {
    console.error('missing lockPath');
    process.exit(2);
}

try {
    const { release } = acquireLock(lockPath);
    // Signal parent that we've acquired.
    process.stdout.write('ACQUIRED\n');

    if (mode === 'die') {
        // Simulate ungraceful death — SIGKILL bypasses the 'exit' handler
        // that acquireLock registers, so the lock file stays behind.
        process.kill(process.pid, 'SIGKILL');
        return;
    }

    // hold: sleep, then release and exit cleanly.
    setTimeout(() => {
        release();
        process.exit(0);
    }, 3000);
} catch (err) {
    process.stdout.write('FAILED:' + (err.code || err.message) + '\n');
    process.exit(3);
}
