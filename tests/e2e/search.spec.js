'use strict';

const { test, expect } = require('@playwright/test');

test.describe('@smoke search', () => {
    test('palette search returns a structured response', async ({ request }) => {
        const res = await request.get('/api/palette?q=a');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toHaveProperty('results');
        expect(Array.isArray(body.results)).toBe(true);
        expect(body.results.length).toBeGreaterThan(0);
    });

    test('interaction search returns a structured response', async ({ request }) => {
        const res = await request.get('/api/search/interactions?q=hi');
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body).toBeTruthy();
    });
});
