/**
 * Every kind of WAV, through the real app, in a real browser.
 *
 * Chromium on its own cannot play or decode 64-bit float WAV or either ADPCM flavour, and the
 * app used to keep whatever it was given — so those files went in, made no sound, and nothing
 * on screen said why. This drops each variant into the app the way a person would and then
 * checks the thing that matters: the recording the app kept for that song actually plays and
 * decodes in this browser.
 *
 * Then one 64-bit float WAV goes all the way to a tab (stub separator on the helper, the real
 * AI transcriber in the page), to show a converted file is as good as any other downstream.
 *
 *   node wavcheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5380);
const FIXTURES = path.join(ROOT, 'src', 'lib', '__fixtures__', 'wav');
const VARIANTS = ['pcm16', 'pcm24', 'pcm32', 'float32', 'float64', 'pcm8', 'mulaw', 'alaw', 'ima_adpcm', 'ms_adpcm', 'rf64', 'surround51'];

/** The open-string line used by the other tab tests, written as 64-bit float WAV. */
function writeFloat64BassLine(file) {
  const SR = 44100;
  const line = [41.203, 55.0, 73.416, 97.999];
  const per = Math.floor(SR * 0.5);
  const lead = Math.floor(SR * 0.75);
  const frames = lead + per * 16;
  const data = Buffer.alloc(frames * 2 * 8);
  let f = lead;
  for (let rep = 0; rep < 4; rep++) {
    for (const hz of line) {
      for (let i = 0; i < per; i++, f++) {
        const t = i / SR;
        const env = Math.exp(-2.5 * t) * (i > per * 0.88 ? 0 : 1);
        const v = env * 0.3 * (Math.sin(2 * Math.PI * hz * t) + 0.45 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t));
        data.writeDoubleLE(v, f * 16);
        data.writeDoubleLE(v, f * 16 + 8);
      }
    }
  }
  const fmt = Buffer.alloc(26);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(18, 4);
  fmt.writeUInt16LE(3, 8); // IEEE float
  fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(SR, 12);
  fmt.writeUInt32LE(SR * 16, 16);
  fmt.writeUInt16LE(16, 20);
  fmt.writeUInt16LE(64, 22);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0);
  head.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  head.write('WAVE', 8);
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0);
  dataHead.writeUInt32LE(data.length, 4);
  fs.writeFileSync(file, Buffer.concat([head, fmt, dataHead, data]));
}

async function waitForLine(child, pattern, label) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 타임아웃`)), 60000);
    const onData = (b) => {
      if (pattern.test(b.toString())) {
        clearTimeout(t);
        setTimeout(resolve, 1200);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

/** Does the recording the app stored for this song play, and decode, in this browser? */
const storedAudioWorks = (page, title) =>
  page.evaluate(
    (title) =>
      new Promise((resolve) => {
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const db = req.result;
          const songs = db.transaction('songs').objectStore('songs').getAll();
          songs.onsuccess = () => {
            const song = songs.result.filter((s) => s.title === title).sort((a, b) => b.updatedAt - a.updatedAt)[0];
            if (!song) return resolve({ found: false });
            const asset = db.transaction('assets').objectStore('assets').get(song.id);
            asset.onsuccess = async () => {
              const blob = asset.result?.audioBlob;
              if (!blob) return resolve({ found: true, hasAudio: false });
              const plays = await new Promise((r) => {
                const a = new Audio();
                a.oncanplay = () => r(true);
                a.onerror = () => r(false);
                a.src = URL.createObjectURL(blob);
                setTimeout(() => r(false), 5000);
              });
              let decodes = false;
              try {
                const ctx = new AudioContext();
                await ctx.decodeAudioData(await blob.arrayBuffer());
                decodes = true;
                void ctx.close();
              } catch {
                decodes = false;
              }
              resolve({ found: true, hasAudio: true, plays, decodes, fileName: song.audioFileName });
            };
          };
        };
        req.onerror = () => resolve({ found: false });
      }),
    title,
  );

const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT)], { cwd: ROOT });
await waitForLine(vite, /ready in|Local:/i, 'vite');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(40000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bassprac-wav-'));
const stubPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bassprac-stub-'));
fs.symlinkSync(path.join(ROOT, 'sidecar', '_stubdemucs', 'demucs'), path.join(stubPath, 'demucs'));
let sidecar = null;
let report = {};

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 30000 });

  /* ------------------- every variant, through "음원 파일 고르기", download step only */
  await page.locator('.start-panel .auto-row input').uncheck();
  const variants = {};
  for (const name of VARIANTS) {
    await page.setInputFiles('#start-file', path.join(FIXTURES, `${name}.wav`));
    await page.waitForFunction(
      () => document.querySelector('.pipeline-step')?.matches('.done, .error'),
      undefined,
      { timeout: 30000 },
    );
    await page.waitForTimeout(800);
    const panel = await page.evaluate(() => ({
      step: document.querySelector('.pipeline-step')?.className.replace('pipeline-step', '').trim(),
      note: document.querySelector('.start-panel .pipeline + .hint')?.textContent?.trim() ?? null,
      errorBar: document.querySelector('.error-bar')?.textContent?.trim() ?? null,
    }));
    variants[name] = { ...panel, stored: await storedAudioWorks(page, name) };
  }

  /* ----------------------------------- the top-bar "원본 음원" button, same check */
  await page.locator('.topbar button', { hasText: '새 곡' }).click();
  await page.waitForTimeout(500);
  await page.setInputFiles('.topbar input[type=file][accept*="audio"]', path.join(FIXTURES, 'ima_adpcm.wav'));
  await page.waitForTimeout(2500);
  const topBar = {
    title: await page.inputValue('.title-input'),
    errorBar: await page.evaluate(() => document.querySelector('.error-bar')?.textContent?.trim() ?? null),
  };
  topBar.stored = await storedAudioWorks(page, topBar.title);

  /* ----------------------- a 64-bit float WAV, all the way to a tab (AI in the page) */
  sidecar = spawn('python3', ['sidecar/server.py'], { cwd: ROOT, env: { ...process.env, PYTHONPATH: stubPath } });
  await waitForLine(sidecar, /사이드카|http:\/\//, 'sidecar');
  await page.locator('.start-panel .youtube-help summary').click();
  await page.locator('.start-panel .youtube-help button', { hasText: '다시 확인' }).click();
  await page.waitForTimeout(1500);
  await page.locator('.start-panel .auto-row input').check();
  const line = path.join(work, 'float64 bass line.wav');
  writeFloat64BassLine(line);
  await page.setInputFiles('#start-file', line);
  await page.waitForFunction(
    () => {
      const steps = [...document.querySelectorAll('.pipeline-step')];
      return steps.length === 3 && (steps.every((s) => s.classList.contains('done')) || steps.some((s) => s.classList.contains('error')));
    },
    undefined,
    { timeout: 300000 },
  );
  await page.waitForTimeout(1500);
  const fullRun = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const steps = [...document.querySelectorAll('.pipeline-step')].map((li) => li.className.replace('pipeline-step', '').trim());
        const error = document.querySelector('.pipeline-step.error')?.textContent?.trim() ?? null;
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const all = req.result.transaction('songs').objectStore('songs').getAll();
          all.onsuccess = () => {
            const song = all.result.find((s) => s.title === 'float64 bass line');
            resolve({ steps, error, tex: song?.scoreData ?? '' });
          };
        };
      }),
  );
  const frets = [...fullRun.tex.split('\n').filter((l) => /^[:r\d]/.test(l)).join(' ').matchAll(/\b(\d+)\.(\d)\b/g)].map((m) => `${m[1]}.${m[2]}`);
  await page.screenshot({ path: path.join(ROOT, 'wav.png') });

  report = { variants, topBar, fullRun: { steps: fullRun.steps, error: fullRun.error, frets }, pageErrors: pageErrors.slice(0, 3) };
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(stubPath, { recursive: true, force: true });
  await browser.close().catch(() => {});
  sidecar?.kill('SIGTERM');
  vite.kill('SIGTERM');
}

const checks = {};
for (const name of VARIANTS) {
  const v = report.variants?.[name];
  checks[`${name}: 불러와짐`] = v?.step === 'done' && !v?.errorBar;
  checks[`${name}: 저장된 음원이 재생·디코딩됨`] = v?.stored?.plays === true && v?.stored?.decodes === true;
}
// The formats every browser already plays are kept as they are, the rest are converted.
checks['pcm16/24는 변환하지 않음'] = !report.variants?.pcm16?.note && !report.variants?.pcm24?.note;
checks['float64·ADPCM은 변환 안내'] = ['float64', 'ima_adpcm', 'ms_adpcm'].every((n) => /16비트 PCM으로 바꿔/.test(report.variants?.[n]?.note ?? ''));
checks['상단 "원본 음원"으로 넣은 ADPCM도 재생됨'] =
  report.topBar?.stored?.plays === true && report.topBar?.stored?.decodes === true && !report.topBar?.errorBar;
checks['float64 WAV → 탭까지 끝남'] = (report.fullRun?.steps ?? []).length === 3 && report.fullRun.steps.every((s) => s === 'done');
checks['그 탭이 연주한 그대로'] =
  JSON.stringify(report.fullRun?.frets) === JSON.stringify(Array.from({ length: 4 }, () => ['0.4', '0.3', '0.2', '0.1']).flat());
checks['페이지 오류 없음'] = (report.pageErrors ?? []).length === 0;

console.log(JSON.stringify({ report, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ WAV 전 형식 통과' : '\n❌ WAV 전 형식 실패');
process.exit(pass ? 0 : 1);
