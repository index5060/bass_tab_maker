/**
 * Graceful-degradation regression test.
 *
 * The bug this exists for: `onnxruntime-web` and `demucs-web` were added as dependencies for
 * stem separation, and anyone who unzipped the new version without re-running `npm install`
 * got a completely blank page — Vite fails to transform any module that names a missing
 * package, and separator.ts sat on App's static import graph.
 *
 * An optional feature must not be able to take the app down. This test yanks both packages
 * out of node_modules, boots a fresh dev server, and asserts the app still renders the tab
 * and stays usable. It puts the packages back afterwards, including on failure.
 *
 *   node degradecheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5270);
const STASH = path.join(ROOT, '.degrade-stash');
// basic-pitch joined these when AI transcription moved into the page: same rule, the app
// must survive without it.
const PACKAGES = ['onnxruntime-web', 'demucs-web', '@spotify/basic-pitch'];

function stash() {
  fs.mkdirSync(STASH, { recursive: true });
  for (const p of PACKAGES) {
    const from = path.join(ROOT, 'node_modules', p);
    if (!fs.existsSync(from)) continue;
    // Scoped packages ("@scope/name") need their scope folder in the stash too.
    fs.mkdirSync(path.dirname(path.join(STASH, p)), { recursive: true });
    fs.renameSync(from, path.join(STASH, p));
  }
}

function restore() {
  for (const p of PACKAGES) {
    const from = path.join(STASH, p);
    const to = path.join(ROOT, 'node_modules', p);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
  }
  fs.rmSync(STASH, { recursive: true, force: true });
}

let server;
let browser;
let report = {};

try {
  console.log('▶ onnxruntime-web / demucs-web / @spotify/basic-pitch 를 node_modules에서 제거');
  stash();

  server = spawn('npx', ['vite', '--port', String(PORT), '--force'], { cwd: ROOT });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('서버 타임아웃')), 90000);
    const onData = (b) => {
      if (/ready in|Local:/i.test(b.toString())) {
        clearTimeout(t);
        setTimeout(resolve, 2000);
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });

  browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  let rendered = false;
  let playerReady = false;
  try {
    await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 25000 });
    rendered = true;
    // The player needs the soundfont loaded and the MIDI generated before the play button
    // enables — that takes a few seconds and is unrelated to the missing ONNX packages.
    // Checking it without waiting fails on timing, not on a defect.
    await page.waitForFunction(
      () => {
        const b = document.querySelector('.btn-play');
        return b && !b.disabled;
      },
      { timeout: 35000 },
    );
    playerReady = true;
  } catch {
    /* reported below */
  }

  const state = await page.evaluate(() => ({
    rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    viteOverlay: !!document.querySelector('vite-error-overlay'),
    stemPanelPresent: !!document.querySelector('.stem-panel'),
    playEnabled: !document.querySelector('.btn-play')?.disabled,
  }));

  await page.screenshot({ path: path.join(ROOT, 'degraded.png') });

  report = {
    ...state,
    tabRendered: rendered,
    playerReady,
    checks: {
      // The whole point: the app boots even with the optional packages gone.
      appNotBlank: state.rootChildren > 0,
      noViteErrorOverlay: !state.viteOverlay,
      tabRendered: rendered,
      playerStillUsable: playerReady && state.playEnabled,
      stemPanelStillShown: state.stemPanelPresent,
    },
  };
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
  restore();
  console.log('▶ 패키지 복원 완료');
}

console.log(JSON.stringify(report, null, 2));
const pass = report.checks && Object.values(report.checks).every(Boolean);
console.log(pass ? '\n✅ 의존성 없이도 앱 생존' : '\n❌ 의존성 빠지면 앱이 죽음');
process.exit(pass ? 0 : 1);
