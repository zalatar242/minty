'use strict';

/**
 * Stagehand-based UI smoke. Run with:
 *   ANTHROPIC_API_KEY=... node tests/e2e/ui-smoke.stagehand.js
 *
 * Skips silently if no API key is present so it doesn't break preflight
 * for contributors without one.
 */

require('dotenv').config({ quiet: true });

const path = require('path');
const { spawn } = require('child_process');

const MINTY_E2E_PORT = Number(process.env.MINTY_E2E_PORT) || 3790;
const BASE_URL = process.env.MINTY_E2E_BASE_URL || `http://127.0.0.1:${MINTY_E2E_PORT}`;
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

if (!HAS_KEY) {
    console.log('ui-smoke.stagehand: skipping (set ANTHROPIC_API_KEY or OPENAI_API_KEY to run)');
    process.exit(0);
}

async function waitForServer(url, timeoutMs = 20_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url + '/api/meta');
            if (res.ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('server did not become ready in time');
}

async function main() {
    const seed = spawn(process.execPath, [path.resolve(__dirname, '../../scripts/seed-dev-data.js'), '--clean'], {
        env: { ...process.env, CRM_DATA_DIR: path.resolve(__dirname, '../../data-e2e') },
        stdio: 'inherit',
    });
    await new Promise((resolve, reject) => {
        seed.on('exit', code => code === 0 ? resolve() : reject(new Error('seed failed')));
    });

    const server = spawn(process.execPath, [path.resolve(__dirname, '../../crm/server.js')], {
        env: {
            ...process.env,
            PORT: String(MINTY_E2E_PORT),
            HOST: '127.0.0.1',
            CRM_DATA_DIR: path.resolve(__dirname, '../../data-e2e'),
            MINTY_E2E: '1',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    let stagehand;
    try {
        await waitForServer(BASE_URL);

        const { Stagehand } = require('@browserbasehq/stagehand');
        stagehand = new Stagehand({
            env: 'LOCAL',
            modelName: process.env.STAGEHAND_MODEL || 'claude-sonnet-4-6',
            modelClientOptions: {
                apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
            },
        });
        await stagehand.init();
        const page = stagehand.page;

        await page.goto(BASE_URL);
        await page.waitForLoadState('domcontentloaded');

        const observation = await stagehand.page.observe({
            instruction: 'find the search or command palette input',
        });
        if (!observation || observation.length === 0) {
            throw new Error('did not find a search input on the page');
        }

        await stagehand.page.act({ action: 'click the search or command palette' });
        await stagehand.page.act({ action: 'type "sam" into the search field' });
        await page.waitForTimeout(500);

        const results = await stagehand.page.extract({
            instruction: 'list the names of the people shown in the search results',
            schema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] },
        });

        if (!results?.names?.length) {
            throw new Error('search returned no visible results');
        }
        console.log('ui-smoke.stagehand: ok, saw', results.names.slice(0, 5));
    } finally {
        if (stagehand) await stagehand.close().catch(() => {});
        server.kill('SIGTERM');
    }
}

main().catch(err => {
    console.error('ui-smoke.stagehand: FAILED', err);
    process.exit(1);
});
