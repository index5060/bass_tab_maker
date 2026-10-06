import { chromium } from 'playwright';

const URL_ = process.env.APP_URL ?? 'http://localhost:5180/';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const bad = [];
page.on('requestfailed', (r) => bad.push(`FAILED ${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) bad.push(`HTTP ${r.status()} ${r.url()}`);
});

await page.goto(URL_, { waitUntil: 'load' });
await page.waitForTimeout(12000);

const info = await page.evaluate(() => {
  const c = document.querySelector('.at-container');
  return {
    containerExists: !!c,
    containerHTMLLength: c ? c.innerHTML.length : 0,
    svgCount: c ? c.querySelectorAll('svg').length : 0,
    canvasCount: c ? c.querySelectorAll('canvas').length : 0,
    innerTextSample: c ? c.innerText.slice(0, 200) : '',
    playDisabled: document.querySelector('.btn-play')?.disabled,
    errorBar: document.querySelector('.error-bar')?.textContent ?? null,
    bravuraLoaded: Array.from(document.fonts).map((f) => `${f.family}:${f.status}`),
  };
});

console.log(JSON.stringify({ info, bad, logs: logs.slice(0, 40) }, null, 2));
await page.screenshot({ path: '/home/claude/bass-practice/devcheck.png' });
await browser.close();
