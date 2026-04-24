#!/usr/bin/env node
'use strict';

// scripts/record-fixtures.js — refresh sources/linkedin/fixtures/*.html
// from the user's existing saved LinkedIn session.
//
// Usage: node scripts/record-fixtures.js
// Prereqs: `npm run linkedin:setup && npm run linkedin:connect` done once.

const fs = require('fs');
const path = require('path');
const SELECTORS = require('../sources/linkedin/selectors');

const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = process.env.LINKEDIN_PROFILE_DIR
    || path.join(ROOT, 'data', 'linkedin', 'browser-profile');
const FIXTURE_DIR = path.join(ROOT, 'sources', 'linkedin', 'fixtures');
const THROTTLE_MS = Number(process.env.LINKEDIN_THROTTLE_MS) || 2000;

async function record(page, url, filename) {
    console.log(`  recording ${filename} from ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(THROTTLE_MS);
    const html = await page.content();
    fs.writeFileSync(path.join(FIXTURE_DIR, filename), html);
}

(async () => {
    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch (_) {
        console.error('Playwright not installed. Run: npm run linkedin:setup');
        process.exit(2);
    }
    if (!fs.existsSync(PROFILE_DIR)) {
        console.error(`No saved profile at ${PROFILE_DIR}. Run: npm run linkedin:connect`);
        process.exit(2);
    }
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });

    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        viewport: { width: 1440, height: 900 },
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    try {
        await record(page, SELECTORS.CONNECTIONS_LIST.url, 'connections-list.html');
        await record(page, SELECTORS.MESSAGING_INBOX.url, 'messaging-inbox.html');
        // Click through to the first thread so we can capture a thread page.
        const firstThreadHref = await page.evaluate((sels) => {
            for (const s of sels.conversationAnchor) {
                const a = document.querySelector(s);
                if (a) return a.getAttribute('href');
            }
            return null;
        }, SELECTORS.MESSAGING_INBOX);
        if (firstThreadHref) {
            const abs = firstThreadHref.startsWith('/')
                ? 'https://www.linkedin.com' + firstThreadHref : firstThreadHref;
            await record(page, abs, 'message-thread.html');
        } else {
            console.warn('  no thread found — skipping message-thread.html');
        }
        // Pick any /in/<slug>/ seen in the connections page as a contact-info target.
        await page.goto(SELECTORS.CONNECTIONS_LIST.url, { waitUntil: 'domcontentloaded' });
        const slug = await page.evaluate(() => {
            const a = document.querySelector('a[href*="/in/"]');
            if (!a) return null;
            const m = /\/in\/([^/?#]+)/.exec(a.getAttribute('href') || '');
            return m ? m[1] : null;
        });
        if (slug) {
            const overlay = SELECTORS.CONTACT_INFO_MODAL.urlTemplate.replace('{slug}', slug);
            await record(page, overlay, 'contact-info-modal.html');
        } else {
            console.warn('  no /in/<slug> anchor — skipping contact-info-modal.html');
        }
    } finally {
        await ctx.close();
    }
    console.log('Fixtures updated');
})().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
