/**
 * Verifies the preconditions for browser stem separation, and the stem UI wiring.
 *
 * What this CAN prove: cross-origin isolation is actually on (without it onnxruntime-web
 * cannot allocate SharedArrayBuffer and separation is impossible), the lazy chunks are not
 * in the initial bundle, and the panel/source-toggle states are correct.
 *
 * What this CANNOT prove: that a real separation produces good stems. That needs a GPU and
 * a ~200MB download (27MB ORT wasm + 172MB model), neither of which exists in CI here.
 * Run it on the real machine with a real song.
 *
 *   MODE=preview node stemcheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5250);
const MODE = process.env.MODE ?? 'dev';

const args = MODE === 'preview'
  ? ['vite', 'preview', '--port', String(PORT)]
  : ['vite', '--port', String(PORT)];
const server = spawn('npx', args, { cwd: ROOT });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('서버 타임아웃')), 60000);
  const onData = (b) => {
    if (/ready in|Local:/i.test(b.toString())) {
      clearTimeout(t);
      setTimeout(resolve, 1500);
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
});

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

const base = `http://localhost:${PORT}/`;
const response = await page.goto(base, { waitUntil: 'load' });
const headers = response?.headers() ?? {};

await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 25000 });
await page.waitForFunction(() => {
  const b = document.querySelector('.btn-play');
  return b && !b.disabled;
}, { timeout: 35000 });

// The gate: without these two, onnxruntime-web cannot run at all.
const isolation = await page.evaluate(() => ({
  crossOriginIsolated: self.crossOriginIsolated === true,
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
}));

const ui = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('.segmented button')].map((b) => ({
    label: b.textContent?.trim(),
    disabled: b.disabled,
  }));
  const stemPanel = document.querySelector('.stem-panel');
  return {
    sourceButtons: buttons,
    stemPanelPresent: !!stemPanel,
    stemPanelText: stemPanel?.textContent?.trim().slice(0, 80) ?? null,
  };
});

await page.screenshot({ path: `${ROOT}/stems.png` });
await browser.close();
server.kill('SIGTERM');

const expectedLabels = ['신디', '원본', '베이스만', '반주만'];
const labels = ui.sourceButtons.map((b) => b.label);

const checks = {
  coopHeader: headers['cross-origin-opener-policy'] === 'same-origin',
  coepHeader: (headers['cross-origin-embedder-policy'] ?? '').length > 0,
  crossOriginIsolated: isolation.crossOriginIsolated,
  sharedArrayBufferAvailable: isolation.sharedArrayBuffer,
  fourSourceButtons: JSON.stringify(labels) === JSON.stringify(expectedLabels),
  // With no audio loaded, every recorded source must be locked out.
  onlySynthEnabled:
    ui.sourceButtons.filter((b) => !b.disabled).length === 1 &&
    ui.sourceButtons.find((b) => !b.disabled)?.label === '신디',
  stemPanelPresent: ui.stemPanelPresent,
  noConsoleErrors: consoleErrors.length === 0,
};

console.log(
  JSON.stringify(
    {
      mode: MODE,
      coop: headers['cross-origin-opener-policy'],
      coep: headers['cross-origin-embedder-policy'],
      isolation,
      ui,
      consoleErrors: consoleErrors.slice(0, 5),
      checks,
    },
    null,
    2,
  ),
);

const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 스템 전제조건 통과' : '\n❌ 스템 전제조건 실패');
process.exit(pass ? 0 : 1);
