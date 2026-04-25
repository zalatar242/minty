'use strict';

const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

const PORT = Number(process.env.MINTY_E2E_PORT) || 3789;
const BASE_URL = process.env.MINTY_E2E_BASE_URL || `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
    testDir: './tests/e2e',
    testIgnore: ['**/_*.js', '**/global-setup.js'],
    globalSetup: require.resolve('./tests/e2e/global-setup.js'),
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',

    use: {
        baseURL: BASE_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },

    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],

    webServer: {
        command: 'node crm/server.js',
        url: `${BASE_URL}/api/meta`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        cwd: path.resolve(__dirname),
        env: {
            PORT: String(PORT),
            HOST: '127.0.0.1',
            CRM_DATA_DIR: path.resolve(__dirname, 'data-e2e'),
            MINTY_E2E: '1',
        },
    },
});
