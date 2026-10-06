/**
 * Cold-start regression test.
 *
 * This is the test that should have existed from the start. It reproduces a fresh checkout:
 * wipe the generated public assets, boot a brand new dev server, and load the page in a real
 * browser. The original bug only ever showed up on the FIRST run after a clone/unzip, so
 * testing a warm tree (or `vite preview` after a successful build) hid it completely.
 *
 *   node coldstart.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5199);
const MODE = process.env.MODE ?? 'dev'; // 'dev' | 'preview'

function rmAssets() {
  for (const d of ['public/font', 'public/soundfont']) {
    fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
  }
}

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서버가 60초 안에 뜨지 않았습니다')), 60000);
    const onData = (buf) => {
      const s = buf.toString();
      process.stdout.write(`  │ ${s}`);
      if (s.includes(`:${port}`) || /ready in/i.test(s)) {
        clearTimeout(timer);
        setTimeout(resolve, 1200);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`서버가 코드 ${code}로 종료되었습니다`));
    });
  });
}

console.log(`▶ 콜드스타트 테스트 (mode=${MODE})`);
console.log('  public/font, public/soundfont 삭제');
rmAssets();

if (MODE === 'preview') {
  console.log('  vite build 실행');
  const build = spawn('npx', ['vite', 'build'], { cwd: ROOT });
  await new Promise((res, rej) =>
    build.on('exit', (c) => (c === 0 ? res() : rej(new Error('build 실패')))),
  );
}

const args = MODE === 'preview' ? ['vite', 'preview', '--port', String(PORT)] : ['vite', '--port', String(PORT)];
const server = spawn('npx', args, { cwd: ROOT });
await waitForServer(server, PORT);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
const fontWarnings = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') consoleErrors.push(t);
  if (/OTS parsing|Failed to decode downloaded font/i.test(t)) fontWarnings.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const badResponses = [];
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('favicon')) badResponses.push(`HTTP ${r.status()} ${r.url()}`);
});

const base = `http://localhost:${PORT}/`;
await page.goto(base, { waitUntil: 'load' });

// The decisive check: are the asset URLs serving real bytes, or the SPA fallback HTML?
const assetCheck = await page.evaluate(async () => {
  const probe = async (url, magic) => {
    const res = await fetch(url);
    const buf = new Uint8Array(await res.arrayBuffer());
    const head = String.fromCharCode(...buf.slice(0, 4));
    return { url, status: res.status, head, ok: head === magic, bytes: buf.length };
  };
  return {
    font: await probe('/font/Bravura.woff2', 'wOF2'),
    soundfont: await probe('/soundfont/sonivox.sf3', 'RIFF'),
  };
});

let rendered = false;
let playerReady = false;
try {
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 25000 });
  rendered = true;
  await page.waitForFunction(() => {
    const b = document.querySelector('.btn-play');
    return b && !b.disabled;
  }, { timeout: 35000 });
  playerReady = true;
} catch {
  /* fall through to the report */
}

const errorBar = await page.locator('.error-bar').textContent().catch(() => null);
await page.screenshot({ path: path.join(ROOT, `coldstart-${MODE}.png`) });
await browser.close();
server.kill('SIGTERM');

const report = {
  mode: MODE,
  assetCheck,
  rendered,
  playerReady,
  errorBar,
  fontWarnings: fontWarnings.slice(0, 3),
  consoleErrors: consoleErrors.slice(0, 5),
  badResponses,
};
console.log(JSON.stringify(report, null, 2));

const pass =
  assetCheck.font.ok &&
  assetCheck.soundfont.ok &&
  rendered &&
  playerReady &&
  !errorBar &&
  fontWarnings.length === 0 &&
  consoleErrors.length === 0 &&
  badResponses.length === 0;

console.log(pass ? '\n✅ 콜드스타트 통과' : '\n❌ 콜드스타트 실패');
process.exit(pass ? 0 : 1);
