/**
 * Does the isolation diagnosis actually tell the truth?
 *
 * A diagnostic that reports the wrong cause is worse than none, so this runs the app twice
 * against dev servers that differ only in whether they send COOP/COEP, and checks that the
 * verdict matches reality both ways.
 *
 *   node diagcheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const CONFIG = path.join(ROOT, 'vite.config.ts');
const BACKUP = path.join(ROOT, '.vite.config.backup');

async function bootServer(port) {
  const server = spawn('npx', ['vite', '--port', String(port), '--force'], { cwd: ROOT });
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
  return server;
}

/**
 * A short real WAV. The stem panel only reaches the separation branch once a song has audio
 * attached — without this the test sits on the "load a track first" message and proves
 * nothing about the diagnosis.
 */
function writeTestWav(file) {
  const sampleRate = 44100;
  const frames = sampleRate; // 1 second
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 110 * i) / sampleRate) * 8000);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 44 + i * 4 + 2);
  }
  fs.writeFileSync(file, buf);
}

async function readPanel(port) {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 25000 });

  const wav = path.join(ROOT, '.diag-test-tone.wav');
  writeTestWav(wav);
  await page.setInputFiles('input[accept*="audio"]', wav);
  await page.waitForTimeout(2500); // let the audio load and the async diagnosis land
  fs.rmSync(wav, { force: true });

  const out = await page.evaluate(() => {
    const runBtn = [...document.querySelectorAll('.stem-panel button')].find((b) =>
      b.textContent?.includes('브라우저에서 분리하기'),
    );
    return {
      isolated: self.crossOriginIsolated === true,
      // The behaviour that matters: separation stays available either way.
      runButtonPresent: !!runBtn,
      runButtonEnabled: !!runBtn && !runBtn.disabled,
      // .mode-line specifically — the panel's intro paragraph also contains <strong>.
      modeLabel: document.querySelector('.stem-panel .mode-line strong')?.textContent ?? null,
      diagVisible: !!document.querySelector('.diag-table'),
      verdict: document.querySelector('.isolation-diag .hint strong')?.textContent ?? null,
      rows: [...document.querySelectorAll('.diag-table tr')].map((tr) => [
        tr.querySelector('th')?.textContent,
        tr.querySelector('td')?.textContent,
      ]),
    };
  });
  await page.screenshot({ path: path.join(ROOT, `diag-${port}.png`) });
  await browser.close();
  return out;
}

let server;
const results = {};

try {
  /* --- case 1: headers present (the normal, working configuration) --- */
  server = await bootServer(5280);
  results.withHeaders = await readPanel(5280);
  server.kill('SIGTERM');
  server = null;

  /* --- case 2: headers stripped, exactly what a stale dev server looks like --- */
  fs.copyFileSync(CONFIG, BACKUP);
  const stripped = fs
    .readFileSync(CONFIG, 'utf8')
    .replace(/headers: CROSS_ORIGIN_ISOLATION,?/g, '');
  fs.writeFileSync(CONFIG, stripped);

  server = await bootServer(5281);
  results.withoutHeaders = await readPanel(5281);
} finally {
  if (server) server.kill('SIGTERM');
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, CONFIG);
    fs.rmSync(BACKUP);
  }
  console.log('▶ vite.config.ts 복원 완료');
}

const checks = {
  isolatedWhenHeadersPresent: results.withHeaders?.isolated === true,
  noDiagShownWhenHealthy: results.withHeaders?.diagVisible === false,
  notIsolatedWhenHeadersMissing: results.withoutHeaders?.isolated === false,
  diagShownWhenBroken: results.withoutHeaders?.diagVisible === true,
  // The whole point of the diagnosis: name the real cause, not a generic shrug.
  verdictBlamesTheServer: /헤더를 아예 안 보내/.test(results.withoutHeaders?.verdict ?? ''),
  reportsHeadersAsMissing: (results.withoutHeaders?.rows ?? []).some(
    ([k, v]) => k === '보낸 COOP' && v === '없음',
  ),
  // The point of the capability rework: isolation controls SPEED, not availability.
  // Separation must stay runnable with the headers gone.
  runnableWithHeaders: results.withHeaders?.runButtonEnabled === true,
  runnableWithoutHeaders: results.withoutHeaders?.runButtonEnabled === true,
  slowModeLabelled: /단일 스레드/.test(results.withoutHeaders?.modeLabel ?? ''),
};

console.log(JSON.stringify({ results, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 진단이 진실을 말함' : '\n❌ 진단이 틀림');
process.exit(pass ? 0 : 1);
