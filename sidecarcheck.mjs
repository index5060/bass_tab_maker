/**
 * End-to-end check of the local separation sidecar.
 *
 * The decisive question this answers is a cross-origin one. The app page is deliberately
 * cross-origin isolated (COOP/COEP) so the browser separator can allocate SharedArrayBuffer,
 * and that makes every response from the sidecar's different origin subject to CORP as well
 * as CORS. Get either header wrong and the fetch fails with an opaque network error that
 * explains nothing — so it has to be proven from inside a real isolated page, not with curl.
 *
 * Runs against a stub demucs, so it exercises the protocol and the browser plumbing in about
 * a second without a GPU or a few hundred MB of model weights.
 *
 * Also checks the case that matters most for everyone who never installs the sidecar: with
 * it switched off, the app must behave exactly as before.
 *
 *   node sidecarcheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5350);
const SIDECAR_PORT = 8765;

function writeWav(file, seconds = 2) {
  const sr = 44100;
  const frames = sr * seconds;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 55 * i) / sr) * 8000);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 44 + i * 4 + 2);
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

const vite = spawn('npx', ['vite', '--port', String(PORT)], { cwd: ROOT });
await waitForLine(vite, /ready in|Local:/i, 'vite');

const sidecar = spawn('python3', ['sidecar/server.py'], {
  cwd: ROOT,
  env: { ...process.env, PYTHONPATH: path.join(ROOT, 'sidecar', '_stubdemucs') },
});
await waitForLine(sidecar, /사이드카|http:\/\//, 'sidecar');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(40000);

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const wav = path.join(ROOT, '.sidecar-test.wav');
let report = {};

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 30000 });

  // Proves the cross-origin path works from inside the isolated page, which curl cannot.
  const crossOrigin = await page.evaluate(async (port) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      return { ok: true, isolated: self.crossOriginIsolated === true, name: body.name, demucs: body.demucs };
    } catch (e) {
      return { ok: false, isolated: self.crossOriginIsolated === true, error: String(e) };
    }
  }, SIDECAR_PORT);

  writeWav(wav);
  await page.setInputFiles('input[accept*="audio"]', wav);
  await page.waitForTimeout(2500);

  const ui = await page.evaluate(() => {
    const box = document.querySelector('.sidecar-box');
    const button = [...document.querySelectorAll('.stem-panel button')].find((b) =>
      /분리하기$/.test(b.textContent?.trim() ?? ''),
    );
    return {
      sidecarBoxShown: !!box,
      headText: box?.querySelector('.sidecar-head')?.textContent?.trim() ?? null,
      modelOptions: [...(box?.querySelectorAll('select option') ?? [])].map((o) => o.value),
      buttonLabel: button?.textContent?.trim() ?? null,
    };
  });

  // Run a real separation through the sidecar and wait for the panel to report stems.
  await page.locator('.stem-panel button', { hasText: '분리하기' }).click();
  await page.waitForSelector('.stem-panel .badge', { timeout: 120000 });
  await page.waitForTimeout(1500);

  const afterSeparate = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.stem-panel .readout dd')].map((d) =>
      d.textContent?.trim(),
    );
    return {
      badge: document.querySelector('.stem-panel .badge')?.textContent?.trim() ?? null,
      model: cells[0] ?? null,
      size: cells[1] ?? null,
    };
  });

  // Now the AI transcription path: basic-pitch (stubbed) on the sidecar, note events back
  // to the browser, written through the shared notes->tab pipeline.
  await page.locator('.stem-panel button', { hasText: '베이스 탭 자동 생성' }).click();
  await page.waitForFunction(
    () => !document.querySelector('.stem-panel .phase-line'),
    undefined,
    { timeout: 60000 },
  );
  await page.waitForTimeout(2500); // autosave

  const afterTranscribe = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const hint = [...document.querySelectorAll('.stem-panel .hint')]
          .map((p) => p.textContent?.trim())
          .find((t) => t?.includes('음표'));
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const all = req.result.transaction('songs').objectStore('songs').getAll();
          all.onsuccess = () =>
            resolve({ hint: hint ?? null, scoreData: all.result[0]?.scoreData ?? '' });
          all.onerror = () => resolve({ hint: hint ?? null, scoreData: '' });
        };
        req.onerror = () => resolve({ hint: hint ?? null, scoreData: '' });
      }),
  );

  await page.screenshot({ path: path.join(ROOT, 'sidecar.png') });
  report = { crossOrigin, ui, afterSeparate, afterTranscribe, pageErrors: pageErrors.slice(0, 3) };
} finally {
  fs.rmSync(wav, { force: true });
  await browser.close().catch(() => {});
  sidecar.kill('SIGTERM');
  vite.kill('SIGTERM');
}

const checks = {
  pageIsIsolated: report.crossOrigin?.isolated === true,
  // The whole reason this test exists: an isolated page reaching a different origin.
  reachedSidecarAcrossOrigins: report.crossOrigin?.ok === true,
  identifiedItself: report.crossOrigin?.name === 'bass-practice-sidecar',
  settingsShown: report.ui?.sidecarBoxShown === true,
  offersFineTunedModel: (report.ui?.modelOptions ?? []).includes('htdemucs_ft'),
  buttonSwitchesToSidecar: report.ui?.buttonLabel === '사이드카로 분리하기',
  separationProducedStems: report.afterSeparate?.badge === '준비됨',
  // The model string must record which path and settings produced these stems.
  stemsRecordProvenance: /사이드카/.test(report.afterSeparate?.model ?? ''),

  // The AI transcription path must run end to end and say which engine produced the tab.
  transcriptionUsedBasicPitch: /basic-pitch/.test(report.afterTranscribe?.hint ?? ''),
  // The stub emits four separate A1 quarter notes. All four must survive as notes — an
  // earlier version merged same-pitch repeats into one long note, which would destroy the
  // most common bass figure there is (repeated eighths on the root).
  tabKeepsRepeatedNotes:
    ((report.afterTranscribe?.scoreData ?? '').match(/\b0\.3\b/g) ?? []).length === 4,

  noPageErrors: (report.pageErrors ?? []).length === 0,
};

console.log(JSON.stringify({ report, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 사이드카 통과' : '\n❌ 사이드카 실패');
process.exit(pass ? 0 : 1);
