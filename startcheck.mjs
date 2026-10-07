/**
 * End-to-end check of the no-install path: audio file -> bass stem -> tab.
 *
 * Two phases.
 *
 * 1. Nothing installed — no helper process at all. The panel must not offer a YouTube field
 *    it cannot honour, and a picked file must start the pipeline as a new song. Step two then
 *    runs the real in-browser separator; in an environment that cannot reach its 172MB model
 *    the run has to stop at that step and say why, not hang or take the page down.
 *
 * 2. The whole chain with the real in-browser AI. A helper is started with ONLY the stub
 *    separator on its path (no basic-pitch, no yt-dlp), so separation is stubbed but
 *    transcription is the actual basic-pitch model running in the page. The input is a
 *    synthesised line whose notes are known — the four open strings, one per beat at 120 BPM,
 *    after a 0.75s lead-in — and the tab has to say exactly that.
 *
 *   node startcheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5370);
const SR = 44100;
const LINE = [41.203, 55.0, 73.416, 97.999]; // E1 A1 D2 G2: open strings 4, 3, 2, 1
const NOTE_SECONDS = 0.5;
const REPEATS = 4;
const LEAD_SECONDS = 0.75;

function writeBassLineWav(file, amplitude = 0.3) {
  const perNote = Math.floor(SR * NOTE_SECONDS);
  const lead = Math.floor(SR * LEAD_SECONDS);
  const frames = lead + perNote * LINE.length * REPEATS;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * 4, 40);
  let cursor = 44 + lead * 4;
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const hz of LINE) {
      for (let i = 0; i < perNote; i++) {
        const t = i / SR;
        // A plucked-string stand-in: fundamental plus two harmonics, decaying, with a short
        // gap so each note is its own pluck. The harmonics are what basic-pitch used to write
        // down as extra notes.
        const env = Math.exp(-2.5 * t) * (i > perNote * 0.88 ? 0 : 1);
        const v =
          env *
          amplitude *
          (Math.sin(2 * Math.PI * hz * t) + 0.45 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t));
        const s = Math.round(Math.max(-1, Math.min(1, v)) * 32000);
        buf.writeInt16LE(s, cursor);
        buf.writeInt16LE(s, cursor + 2);
        cursor += 4;
      }
    }
  }
  fs.writeFileSync(file, buf);
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

const pipelineSteps = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pipeline-step')].map((li) => ({
      state: li.className.replace('pipeline-step', '').trim(),
      text: li.textContent?.trim() ?? '',
    })),
  );

const readScore = (page, title) =>
  page.evaluate(
    (title) =>
      new Promise((resolve) => {
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const all = req.result.transaction('songs').objectStore('songs').getAll();
          all.onsuccess = () => resolve(all.result.find((s) => s.title === title)?.scoreData ?? '');
          all.onerror = () => resolve('');
        };
        req.onerror = () => resolve('');
      }),
    title,
  );

// Run vite directly (not through npx) so killing it really stops the server.
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT)], {
  cwd: ROOT,
});
await waitForLine(vite, /ready in|Local:/i, 'vite');

const wav = path.join(ROOT, '.start-test.wav');
writeBassLineWav(wav);
// A second name for phase two, so its song is not confused with phase one's.
const wav2 = path.join(ROOT, '.start-test-2.wav');
fs.copyFileSync(wav, wav2);

// The separator stub alone, so the helper offers separation but no transcription and no
// YouTube — transcription then has to come from the browser.
const stubPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bassprac-stub-'));
fs.symlinkSync(path.join(ROOT, 'sidecar', '_stubdemucs', 'demucs'), path.join(stubPath, 'demucs'));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(40000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

let sidecar = null;
let report = {};

try {
  /* ------------------------------------------------- phase 1: nothing installed */
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 30000 });
  await page.waitForSelector('.start-panel .youtube-help', { timeout: 10000 });

  const bare = await page.evaluate(() => ({
    youtubeField: !!document.querySelector('.start-panel input[type="url"]'),
    helpShown: !!document.querySelector('.start-panel .youtube-help'),
    fileButton: document.querySelector('.start-panel label[for="start-file"]')?.textContent?.trim() ?? null,
  }));

  await page.setInputFiles('#start-file', wav);
  await page.waitForSelector('.pipeline-step.error', { timeout: 180000 });
  const bareRun = {
    steps: await pipelineSteps(page),
    title: await page.inputValue('.title-input'),
  };

  /* ------------------------------------- phase 2: the full chain, AI in the page */
  sidecar = spawn('python3', ['sidecar/server.py'], {
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: stubPath },
  });
  await waitForLine(sidecar, /사이드카|http:\/\//, 'sidecar');
  await page.locator('.start-panel .youtube-help summary').click();
  await page.locator('.start-panel .youtube-help button', { hasText: '다시 확인' }).click();
  await page.waitForSelector('.stem-panel .sidecar-box, .start-panel', { timeout: 10000 });
  await page.waitForTimeout(1000);
  // Whether this machine's Python has yt-dlp is not the test's to decide; the field must
  // simply follow what the helper reports.
  const health = await (await fetch('http://127.0.0.1:8765/health')).json();
  const helperFound = {
    ytdlp: health.ytdlp ?? null,
    youtubeField: await page.locator('.start-panel input[type="url"]').count(),
  };

  await page.setInputFiles('#start-file', wav2);
  await page.waitForFunction(
    () => {
      const steps = [...document.querySelectorAll('.pipeline-step')];
      return steps.length === 3 && (steps.every((s) => s.classList.contains('done')) || steps.some((s) => s.classList.contains('error')));
    },
    { timeout: 300000 },
  );
  await page.waitForTimeout(1500);

  const fullRun = await page.evaluate(() => ({
    steps: [...document.querySelectorAll('.pipeline-step')].map((li) => li.className.replace('pipeline-step', '').trim()),
    error: document.querySelector('.pipeline-step.error')?.textContent?.trim() ?? null,
    title: document.querySelector('.title-input')?.value ?? null,
    tabHint:
      [...document.querySelectorAll('.stem-panel .hint')].map((p) => p.textContent?.trim()).find((t) => t?.includes('음표')) ?? null,
    fallback:
      [...document.querySelectorAll('.stem-panel .hint')].map((p) => p.textContent?.trim()).find((t) => t?.includes('내장 채보로')) ?? null,
  }));
  const tex = await readScore(page, fullRun.title);
  const body = tex.split('\n').filter((l) => /^[:r\d]/.test(l));
  const frets = [...body.join(' ').matchAll(/\b(\d+)\.(\d)\b/g)].map((m) => `${m[1]}.${m[2]}`);

  await page.screenshot({ path: path.join(ROOT, 'start.png') });

  report = { bare, bareRun, helperFound, fullRun, frets, firstBar: body[0] ?? null, pageErrors: pageErrors.slice(0, 3) };
} finally {
  fs.rmSync(wav, { force: true });
  fs.rmSync(wav2, { force: true });
  fs.rmSync(stubPath, { recursive: true, force: true });
  await browser.close().catch(() => {});
  sidecar?.kill('SIGTERM');
  vite.kill('SIGTERM');
}

const expectedLine = Array.from({ length: REPEATS }, () => ['0.4', '0.3', '0.2', '0.1']).flat();
const checks = {
  // Nothing installed: no YouTube field that could only fail, but a pointer to how to get it.
  noYouTubeFieldWithoutHelper: report.bare?.youtubeField === false && report.bare?.helpShown === true,
  fileIsTheWayIn: report.bare?.fileButton === '음원 파일 고르기',
  fileStartsANewSongNamedAfterIt: report.bareRun?.title === '.start-test',
  secondFileIsAnotherSong: report.fullRun?.title === '.start-test-2',
  fileStepCompletes: report.bareRun?.steps?.[0]?.state === 'done',
  // The browser separator was really tried, and its failure stopped the run at that step.
  browserSeparationFailureIsReported:
    report.bareRun?.steps?.[1]?.state === 'error' && (report.bareRun?.steps?.[1]?.text ?? '').length > '2베이스 분리'.length,
  laterStepsUntouched: report.bareRun?.steps?.[2]?.state === 'todo',

  // Once a helper is found, the YouTube field appears exactly when it has yt-dlp.
  youtubeFieldFollowsHelper: report.helperFound?.youtubeField === (report.helperFound?.ytdlp ? 1 : 0),
  separationFailureSaysWhatToDo: /분리 모델.*내려받지 못했습니다/.test(report.bareRun?.steps?.[1]?.text ?? ''),

  fullChainCompletes: (report.fullRun?.steps ?? []).length === 3 && report.fullRun.steps.every((s) => s === 'done'),
  // The tab came from the AI model running in the page, not from the fallback detector.
  transcribedByBrowserAi: /basic-pitch/.test(report.fullRun?.tabHint ?? '') && !report.fullRun?.fallback,
  // Exactly the line that was played: sixteen notes, open strings in order. Overtones written
  // as notes, split notes, or a wrong fret choice all fail this.
  tabIsExactlyTheLine: JSON.stringify(report.frets) === JSON.stringify(expectedLine),
  // The 0.75s lead-in is a dotted-quarter of rest at 120 BPM: notes sit where they were played.
  leadInIsRest: /^:4 r :8 r :4 0\.4/.test(report.firstBar ?? ''),
  tempoFound: /120\.\d BPM/.test(report.fullRun?.tabHint ?? ''),

  noPageErrors: (report.pageErrors ?? []).length === 0,
};

console.log(JSON.stringify({ report, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 설치 없는 파일 → 탭 통과' : '\n❌ 설치 없는 파일 → 탭 실패');
process.exit(pass ? 0 : 1);
