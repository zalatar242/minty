/**
 * tests/unit/ui-js-syntax.test.js — guard against the entire served
 * <script> blob going invalid.
 *
 * crm/server.js embeds a ~150KB block of inline frontend JS inside a Node.js
 * template literal. Backslash-depth errors in that source produce broken regex
 * literals, half-escaped strings, or stray newlines inside regex/string
 * literals that then throw on parse in the browser — halting every subsequent
 * script on the page, which makes the UI stick at "Loading…" forever.
 *
 * This test extracts the inline <script> and parses it with the Node VM to
 * catch the breakage in CI without needing a headless browser.
 *
 * Regression from PR #7 (XSS jsAttr escaping). Keep this test alive.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const vm = require('vm');

// Import serveIndex-style behavior indirectly: just start the server on a
// random free port and fetch "/".
function fetchRoot(port) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: '/',
                   headers: { Host: '127.0.0.1' } }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

function extractInlineScripts(html) {
    const out = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
}

test('[UI]: inline <script> blocks are syntactically valid JS', async () => {
    // Spawn the server in-process by require()-ing it with a test port.
    const serverScript = require.resolve('../../crm/server.js');
    // Child process to avoid polluting this test process.
    const { spawn } = require('child_process');
    const port = 3459 + Math.floor(Math.random() * 100);
    const child = spawn(process.execPath, [serverScript], {
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        // Wait for server to be ready.
        const ready = await new Promise((resolve) => {
            const tick = setInterval(async () => {
                try {
                    const r = await fetchRoot(port);
                    if (r.status === 200 || r.status === 403) {
                        clearInterval(tick);
                        resolve(r);
                    }
                } catch { /* not ready yet */ }
            }, 100);
            setTimeout(() => { clearInterval(tick); resolve(null); }, 10000);
        });
        assert.ok(ready, 'server did not start within 10s');

        const scripts = extractInlineScripts(ready.body);
        assert.ok(scripts.length > 0, 'no inline <script> blocks found in served HTML');

        for (let i = 0; i < scripts.length; i++) {
            const src = scripts[i];
            if (src.trim().length < 100) continue; // skip trivial inline scripts
            try {
                // vm.Script parses but does not execute — equivalent to `node --check`.
                new vm.Script(src, { filename: `inline-script-${i}` });
            } catch (e) {
                assert.fail(`inline <script> block ${i} failed to parse: ${e.message}`);
            }
        }
    } finally {
        child.kill('SIGTERM');
    }
});
