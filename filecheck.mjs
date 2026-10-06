/**
 * What actually happens when you double-click index.html instead of running a server?
 * Tests the three things a person might plausibly open.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = import.meta.dirname;

const targets = [
  { name: '프로젝트 루트 index.html (file://)', url: 'file://' + path.join(ROOT, 'index.html') },
  { name: 'dist/index.html (file://)', url: 'file://' + path.join(ROOT, 'dist', 'index.html') },
];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

for (const t of targets) {
  const filePath = t.url.replace('file://', '');
  if (!fs.existsSync(filePath)) {
    console.log(`\n### ${t.name}\n  (파일 없음: ${filePath})`);
    continue;
  }

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`FAILED ${r.url().slice(0, 90)} :: ${r.failure()?.errorText}`));

  await page.goto(t.url, { waitUntil: 'load' }).catch((e) => errors.push(`goto: ${e.message}`));
  await page.waitForTimeout(4000);

  const body = await page.evaluate(() => ({
    rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    textLength: document.body.innerText.trim().length,
    hasTab: !!document.querySelector('.at-container svg, .at-container canvas'),
  }));

  console.log(`\n### ${t.name}`);
  console.log('  ' + JSON.stringify(body));
  console.log('  에러 ' + errors.length + '건:');
  for (const e of [...new Set(errors)].slice(0, 5)) console.log('    - ' + e.slice(0, 160));
  await page.close();
}

await browser.close();
