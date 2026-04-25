'use strict';

const { test, expect } = require('@playwright/test');

test.describe('@smoke server boot', () => {
    test('serves the SPA at /', async ({ page }) => {
        const response = await page.goto('/');
        expect(response?.status()).toBe(200);
        await expect(page).toHaveTitle(/minty/i);
    });

    test('responds to /api/meta', async ({ request }) => {
        const res = await request.get('/api/meta');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toHaveProperty('version');
    });

    test('lists contacts via /api/contacts', async ({ request }) => {
        const res = await request.get('/api/contacts');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBeGreaterThan(0);
    });
});
