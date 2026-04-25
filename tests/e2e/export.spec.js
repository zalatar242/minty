'use strict';

const { test, expect } = require('@playwright/test');

test.describe('@smoke export', () => {
    test('unencrypted export returns a non-empty bundle', async ({ request }) => {
        const res = await request.get('/api/export');
        expect(res.ok()).toBeTruthy();
        const buf = await res.body();
        expect(buf.length).toBeGreaterThan(0);
    });
});
