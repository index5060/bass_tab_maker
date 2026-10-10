/**
 * End-to-end check of "YouTube link -> audio file -> bass stem -> tab".
 *
 * Runs the real app against the sidecar with stub yt-dlp / demucs / basic-pitch (see
 * sidecar/_stubdemucs), so the whole chain — the link check, the download job, separation,
 * transcription, saving, and every "save as file" button — is exercised in seconds, with no
 * network and no GPU. The stubs fabricate the audio; what is under test is the plumbing.
 *
 * Also checks the failure paths a real user will hit: a video yt-dlp cannot fetch must stop
 * the pipeline at step one and say why, and a page on another origin must not be able to
 * drive the sidecar at all.
 *
 *   node youtubecheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5360);
const SIDECAR = 'http://127.0.0.1:8765';
const VIDEO_ID = 'dQw4w9WgXcQ';

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

/** Click a button and capture the file the browser downloads because of it. */
async function captureDownload(page, locator) {
  const [download] = await Promise.all([page.waitForEvent('download'), locator.click()]);
  const file = await download.path();
  const head = file ? fs.readFileSync(file).subarray(0, 4).toString('latin1') : '';
  return { name: download.suggestedFilename(), head };
}

const readSongs = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const all = req.result.transaction('songs').objectStore('songs').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      }),
  );

const pipelineSteps = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pipeline-step')].map((li) => ({
      state: li.className.replace('pipeline-step', '').trim(),
      text: li.textContent?.trim() ?? '',
    })),
  );

const vite = spawn('npx', ['vite', '--port', String(PORT)], { cwd: ROOT });
await waitForLine(vite, /ready in|Local:/i, 'vite');

const sidecar = spawn('python3', ['sidecar/server.py'], {
  cwd: ROOT,
  env: { ...process.env, PYTHONPATH: path.join(ROOT, 'sidecar', '_stubdemucs') },
});
await waitForLine(sidecar, /사이드카|http:\/\//, 'sidecar');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
page.setDefaultTimeout(40000);

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

let report = {};

try {
  // Another site open in the same browser must not be able to start work on the sidecar.
  const foreign = await fetch(`${SIDECAR}/youtube`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `https://youtu.be/${VIDEO_ID}` }),
  });
  // And the sidecar must refuse to fetch anything that is not YouTube, whoever asks.
  const offHost = await fetch(`${SIDECAR}/youtube`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `https://evil.example.com/watch?v=${VIDEO_ID}` }),
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 30000 });
  await page.waitForSelector('.start-panel .badge', { timeout: 10000 });

  const input = page.locator('.start-panel input[type="url"]');
  const go = page.locator('.start-panel button', { hasText: '가져오기' });

  // Not a link: the button must stay off and say why.
  await input.fill('그냥 노래 제목');
  const rejectsText = {
    disabled: await go.isDisabled(),
    warning: await page.locator('.start-panel .hint.warn').first().textContent(),
  };

  // The full run, from a messy share link with a playlist and a timestamp attached.
  await input.fill(`https://youtu.be/${VIDEO_ID}?si=AbCdEf&t=42&list=PLabcdefghij`);
  await go.click();
  await page.waitForFunction(
    () => {
      const steps = [...document.querySelectorAll('.pipeline-step')];
      return steps.length === 3 && steps.every((s) => s.classList.contains('done'));
    },
    undefined,
    { timeout: 120000 },
  );
  await page.waitForTimeout(1500); // let the score render and the autosave land

  const afterRun = await page.evaluate(() => ({
    title: document.querySelector('.title-input')?.value ?? null,
    stemBadge: document.querySelector('.stem-panel .badge')?.textContent?.trim() ?? null,
    tabHint:
      [...document.querySelectorAll('.stem-panel .hint')]
        .map((p) => p.textContent?.trim())
        .find((t) => t?.includes('음표')) ?? null,
    audioRow: document.querySelector('.audio-file-row')?.textContent?.trim() ?? null,
    librarySongs: [...document.querySelectorAll('.song-list li > .link:first-child')].map((a) =>
      a.textContent?.trim(),
    ),
  }));
  const savedSong = (await readSongs(page)).find((s) => s.title === afterRun.title) ?? null;

  // Each step's result has to come out as a file.
  const audioFile = await captureDownload(page, page.locator('.audio-file-row button'));
  const bassFile = await captureDownload(page, page.locator('.stem-panel button', { hasText: '베이스 WAV 저장' }));
  const tabFile = await captureDownload(page, page.locator('.topbar button', { hasText: '탭 저장' }));

  await page.screenshot({ path: path.join(ROOT, 'youtube.png') });

  // A video yt-dlp cannot fetch: the run must stop at step one and say why.
  await input.fill('https://www.youtube.com/watch?v=Unavailable');
  await go.click();
  await page.waitForSelector('.pipeline-step.error', { timeout: 30000 });
  const failed = await pipelineSteps(page);

  // Download only: with auto off it must stop after the audio, as a new song. Pasted without
  // a scheme, the way links often get copied — the browser's own url validation used to
  // block exactly this submit without a word.
  await page.locator('.start-panel .auto-row input').uncheck();
  await input.fill('music.youtube.com/watch?v=abcdefghijk');
  await go.click();
  await page.waitForFunction(() => document.querySelector('.pipeline-step')?.classList.contains('done'), undefined, {
    timeout: 30000,
  });
  await page.waitForTimeout(1000);
  const downloadOnly = await page.evaluate(() => ({
    steps: document.querySelectorAll('.pipeline-step').length,
    title: document.querySelector('.title-input')?.value ?? null,
    stemBadge: document.querySelector('.stem-panel .badge')?.textContent?.trim() ?? null,
    separateButton: [...document.querySelectorAll('.stem-panel button')].some((b) =>
      /분리하기$/.test(b.textContent?.trim() ?? ''),
    ),
  }));

  report = {
    foreignStatus: foreign.status,
    offHostStatus: offHost.status,
    rejectsText,
    afterRun,
    savedSong: savedSong && {
      sourceUrl: savedSong.sourceUrl,
      audioFileName: savedSong.audioFileName,
      hasAudio: savedSong.hasAudio,
      hasStems: savedSong.hasStems,
      notesInTab: ((savedSong.scoreData ?? '').match(/\b0\.3\b/g) ?? []).length,
    },
    files: { audioFile, bassFile, tabFile },
    failed,
    downloadOnly,
    pageErrors: pageErrors.slice(0, 3),
  };
} finally {
  await browser.close().catch(() => {});
  sidecar.kill('SIGTERM');
  vite.kill('SIGTERM');
}

const checks = {
  foreignOriginRefused: report.foreignStatus === 403,
  nonYouTubeHostRefused: report.offHostStatus === 400,
  nonLinkKeepsButtonOff: report.rejectsText?.disabled === true,

  // MVP 1: the link became an audio file on a new song named after the video.
  songNamedAfterVideo: report.afterRun?.title === `Stub Song ${VIDEO_ID}`,
  songInLibrary: (report.afterRun?.librarySongs ?? []).includes(`Stub Song ${VIDEO_ID}`),
  audioStored: report.savedSong?.hasAudio === true,
  // The playlist and timestamp were stripped; only the one video was fetched.
  sourceUrlCanonical: report.savedSong?.sourceUrl === `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  audioSavedAsFile: report.files?.audioFile?.name === `Stub Song ${VIDEO_ID}.wav`,

  // MVP 2: the bass came out of it.
  stemsMade: report.afterRun?.stemBadge === '준비됨' && report.savedSong?.hasStems === true,
  bassSavedAsWav:
    report.files?.bassFile?.name === `Stub Song ${VIDEO_ID}-bass.wav` && report.files?.bassFile?.head === 'RIFF',

  // MVP 3: a tab was written from the bass, and comes out as a Guitar Pro file.
  tabWrittenByAi: /basic-pitch/.test(report.afterRun?.tabHint ?? ''),
  // The stub plays A1 (open A string = "0.3") every half second for four seconds.
  tabHasTheNotes: (report.savedSong?.notesInTab ?? 0) >= 4,
  // Guitar Pro 7 files are zip archives.
  tabSavedAsGp: report.files?.tabFile?.name === `Stub Song ${VIDEO_ID}.gp` && report.files?.tabFile?.head.startsWith('PK'),

  failureStopsAtDownload:
    report.failed?.[0]?.state === 'error' && /unavailable/i.test(report.failed?.[0]?.text ?? ''),
  failureLeavesLaterStepsUntouched: (report.failed ?? []).slice(1).every((s) => s.state === 'todo'),

  downloadOnlyShowsOneStep: report.downloadOnly?.steps === 1,
  downloadOnlyMakesNewSong: report.downloadOnly?.title === 'Stub Song abcdefghijk',
  downloadOnlyLeavesSeparationToYou:
    report.downloadOnly?.stemBadge === null && report.downloadOnly?.separateButton === true,

  noPageErrors: (report.pageErrors ?? []).length === 0,
};

console.log(JSON.stringify({ report, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ YouTube 파이프라인 통과' : '\n❌ YouTube 파이프라인 실패');
process.exit(pass ? 0 : 1);
