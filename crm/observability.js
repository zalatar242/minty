/**
 * crm/observability.js — minimal observability hook.
 *
 * Intentionally tiny. Logs uncaught exceptions and unhandled rejections so a
 * crash leaves a recognisable trace in the console; otherwise no-op. Future
 * work could hook structured-log output, metrics counters, or external
 * exporters here behind env flags.
 */

'use strict';

let _initialized = false;

function init() {
    if (_initialized) return;
    _initialized = true;
    process.on('uncaughtException', (err) => {
        console.error('[observability] uncaughtException:', err && (err.stack || err.message || err));
    });
    process.on('unhandledRejection', (reason) => {
        console.error('[observability] unhandledRejection:', reason && (reason.stack || reason.message || reason));
    });
}

module.exports = { init };
