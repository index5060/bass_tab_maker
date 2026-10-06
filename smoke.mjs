/**
 * Headless smoke test: does the app actually boot, parse the alphaTex score, render tab,
 * load the soundfont, and reach playerReady? Run with the preview server already up.
 */
import { chromium } from 'playwright';

const URL_ = process.env.APP_URL ?? 'http://localhost:4173/';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const failedRequests = [];
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.url()} :: HTTP ${r.status()}`);
});

await page.goto(URL_, { waitUntil: 'networkidle' });

const results = {};

// 1. Tab actually rendered (alphaTab draws into svg/canvas inside .at-container)
await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 20000 });
results.tabRendered = true;

// 2. The score title from the alphaTex source made it into the UI
results.title = await page.locator('.topbar h1').textContent();

// 3. Fret numbers are present in the rendered tab
const tabText = await page.locator('.at-container').innerText().catch(() => '');
results.tabHasContent = tabText.trim().length > 0;

// 4. Player becomes ready (soundfont loaded + midi generated) -> play button enables
await page.waitForFunction(
  () => {
    const b = document.querySelector('.btn-play');
    return b && !b.disabled;
  },
  { timeout: 30000 },
);
results.playerReady = true;

// 5. Speed controls are wired
await page.locator('.speed-presets .chip', { hasText: '70' }).click();
results.speedLabel = (await page.locator('.speed-label').innerText()).replace(/\s+/g, ' ');

// 6. "원본" must be disabled with no audio + no anchors — this is the guard that stops
//    the app from playing a desynced recording.
results.originalDisabled = await page.locator('.segmented button', { hasText: '원본' }).isDisabled();

// 7. Playback actually advances the transport clock
await page.locator('.btn-play').click();
await page.waitForTimeout(2500);
const timeText = await page.locator('.time-readout').innerText();
results.timeAfterPlay = timeText.replace(/\s+/g, ' ');
results.clockAdvanced = !/^0:00/.test(timeText.trim());
await page.locator('.btn-play').click();

// 8. Sidebar sync panel reports the anchor requirement
results.syncBadge = await page.locator('.sync-panel .badge').innerText();

await page.screenshot({ path: 'smoke.png', fullPage: false });

results.consoleErrors = consoleErrors;
results.failedRequests = failedRequests.filter((u) => !u.includes('favicon'));

console.log(JSON.stringify(results, null, 2));
await browser.close();

const fatal =
  !results.tabRendered ||
  !results.playerReady ||
  !results.clockAdvanced ||
  results.consoleErrors.length > 0 ||
  results.failedRequests.length > 0;
process.exit(fatal ? 1 : 0);
