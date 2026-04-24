// scratch/linkedin-session-probe.js
// Prerequisite: npm install playwright && npx playwright install chromium
try { require('playwright'); } catch {
  console.error("Playwright not installed. Run: npm install playwright && npx playwright install chromium");
  process.exit(1);
}
const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const profileDir = './scratch-profile';

(async () => {
  const ctx1 = await chromium.launchPersistentContext(profileDir, { headless: false });
  const page1 = await ctx1.newPage();
  await page1.goto('https://linkedin.com');
  console.log('Log in now, solve 2FA. When you are fully logged in and see your feed, press Enter here.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('', () => { rl.close(); resolve(); }));
  await ctx1.close();

  const ctx2 = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  const page2 = await ctx2.newPage();
  await page2.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/');
  await page2.waitForTimeout(3000);
  await page2.screenshot({ path: 'session-probe.png' });
  console.log('URL after headless visit:', page2.url());
  await ctx2.close();

  // Cleanup — profile contains a real LinkedIn session cookie. Do NOT leave it on disk.
  console.log('Cleaning up scratch-profile/ (contains real LinkedIn cookie)...');
  fs.rmSync(profileDir, { recursive: true, force: true });
})();
