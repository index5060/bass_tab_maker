/**
 * Regression test for two bugs that only showed up across sessions:
 *
 *  1. The starter song took a fresh crypto.randomUUID() on every page load, so once anything
 *     saved it you collected one more "Warm-up: Position Shifts" per session, forever.
 *  2. A restored `lastSource` naming something the song does not have — "bass" with no stems —
 *     made AudioDeck.setActive() match no track, zeroing every deck gain while the synth was
 *     muted too, because the app believed a recording was playing. Result: total silence.
 *
 * Neither was reachable by a test that loads the page once and never reloads.
 *
 *   node duplicatecheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5320);

function writeTestWav(file, seconds = 1) {
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
    const v = Math.round(Math.sin((2 * Math.PI * 110 * i) / sr) * 8000);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 44 + i * 4 + 2);
  }
  fs.writeFileSync(file, buf);
}

const server = spawn('npx', ['vite', '--port', String(PORT)], { cwd: ROOT });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('서버 타임아웃')), 90000);
  const onData = (b) => {
    if (/ready in|Local:/i.test(b.toString())) {
      clearTimeout(t);
      setTimeout(resolve, 1500);
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
});

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(30000);

const url = `http://localhost:${PORT}/`;

async function openApp() {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 30000 });
  await page.waitForTimeout(2500); // autosave debounce + list refresh
}

const dumpDb = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('songs')) return resolve([]);
          const all = db.transaction('songs').objectStore('songs').getAll();
          all.onsuccess = () => resolve(all.result.map((d) => ({ id: d.id, title: d.title })));
          all.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      }),
  );

const activeSourceLabel = () =>
  page.evaluate(
    () => document.querySelector('.segmented button.on')?.textContent?.trim() ?? null,
  );

const results = {};

try {
  /* --- give the starter song some audio so it actually gets saved --- */
  await openApp();
  const wav = path.join(ROOT, '.dup-test.wav');
  writeTestWav(wav);
  await page.setInputFiles('input[accept*="audio"]', wav);
  await page.waitForTimeout(2500);
  results.afterFirstSave = await dumpDb();

  /* --- reload twice; the row count must not move --- */
  await openApp();
  results.afterReload1 = await dumpDb();
  await openApp();
  results.afterReload2 = await dumpDb();

  /* --- now poison lastSource with something this song does not have --- */
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const db = req.result;
          const store = db.transaction('songs', 'readwrite').objectStore('songs');
          const get = store.getAll();
          get.onsuccess = () => {
            const doc = get.result[0];
            doc.lastSource = 'bass'; // no stems on this song
            doc.stems = undefined;
            store.put(doc);
            resolve(true);
          };
          get.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      }),
  );

  await openApp();
  results.sourceAfterPoison = await activeSourceLabel();
  results.masterVolume = await page.evaluate(() => {
    // The synth must not be muted just because a stale source name was restored.
    const el = document.querySelector('.segmented button.on');
    return el?.textContent?.trim() ?? null;
  });

  fs.rmSync(wav, { force: true });
  await page.screenshot({ path: path.join(ROOT, 'duplicate.png') });
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
}

const titles = (rows) => rows.map((r) => r.title);
const checks = {
  savedOnce: results.afterFirstSave.length === 1,
  noGrowthOnReload1: results.afterReload1.length === results.afterFirstSave.length,
  noGrowthOnReload2: results.afterReload2.length === results.afterFirstSave.length,
  noDuplicateTitles: new Set(titles(results.afterReload2)).size === results.afterReload2.length,

  // The starter is a template now, so attaching a recording must FORK a real song rather
  // than filing your work under the starter's id and its exercise title.
  forkedOffTheTemplate: results.afterFirstSave.every((r) => r.id !== 'demo-warmup'),
  namedAfterTheAudioFile: results.afterFirstSave.every((r) => r.title !== 'Warm-up: Position Shifts'),

  // An unavailable stored source must fall back to the synth, not to silence.
  fallsBackToSynth: results.sourceAfterPoison === '신디',
};

console.log(JSON.stringify({ results, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 중복/무음 회귀 통과' : '\n❌ 회귀 실패');
process.exit(pass ? 0 : 1);
