/**
 * End-to-end check of automatic tab generation.
 *
 * Feeds the app a synthesised bass line whose notes are known in advance — the four open
 * strings, one per beat at 120 BPM — and checks the generated tab actually says so.
 *
 * The audio doubles as its own "bass stem" through the import path, so this exercises the
 * whole chain (decode -> mono -> decimate -> YIN -> segment -> quantise -> fretboard ->
 * alphaTex -> alphaTab) without downloading a 172MB model.
 *
 *   node autotabcheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5340);

const SR = 44100;
// Open E1, A1, D2, G2 — every one of them fret 0, on strings 4, 3, 2 and 1.
const LINE = [
  { hz: 41.203, string: 4 },
  { hz: 55.0, string: 3 },
  { hz: 73.416, string: 2 },
  { hz: 97.999, string: 1 },
];
const NOTE_SECONDS = 0.5; // one beat at 120 BPM
const REPEATS = 4;
// Real songs do not start on a barline. The lead-in verifies that notes still land at their
// correct ABSOLUTE positions (later slots), which is what keeps the 1:1 cursor sync honest.
const LEAD_SECONDS = 0.75;

/**
 * `amplitude` matters more than it looks. A real separated bass stem is only a slice of the
 * original mix's energy and often lands very quiet — quiet enough that the first version's
 * fixed level gate silenced an entire song and produced a page of rests. Running this at a
 * realistic low level is the point of the test.
 */
function writeBassLineWav(file, amplitude = 0.55) {
  const perNote = Math.floor(SR * NOTE_SECONDS);
  const leadFrames = Math.floor(SR * LEAD_SECONDS);
  const frames = leadFrames + perNote * LINE.length * REPEATS;
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

  let cursor = 44 + leadFrames * 4; // the lead-in stays zero-filled (silence)
  for (let rep = 0; rep < REPEATS; rep++) {
    for (const note of LINE) {
      for (let i = 0; i < perNote; i++) {
        const t = i / SR;
        // Fundamental plus two harmonics, with a pluck-like decay and a short gap at the end
        // so the segmenter sees four separate notes rather than one long smear.
        const envelope = Math.exp(-2.5 * t) * (i > perNote * 0.88 ? 0 : 1);
        const v =
          envelope *
          amplitude *
          (Math.sin(2 * Math.PI * note.hz * t) +
            0.45 * Math.sin(4 * Math.PI * note.hz * t) +
            0.2 * Math.sin(6 * Math.PI * note.hz * t));
        const s = Math.max(-1, Math.min(1, v));
        const i16 = Math.round(s * 32000);
        buf.writeInt16LE(i16, cursor);
        buf.writeInt16LE(i16, cursor + 2);
        cursor += 4;
      }
    }
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(40000);

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let report = {};
const wav = path.join(ROOT, '.autotab-test.wav');

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 30000 });

  // Deliberately quiet — about 3% of full scale, in the range a separated stem really lands.
  writeBassLineWav(wav, Number(process.env.AMPLITUDE ?? 0.03));
  await page.setInputFiles('input[accept*="audio"]', wav);
  await page.waitForTimeout(3000);

  const titleAfterAudio = await page.inputValue('.title-input');

  // Same file as the "bass stem": minus-one comes out silent, which is correct arithmetic
  // and irrelevant here — we only need stems.bass to exist and hold the line.
  await page.locator('.local-import summary').click();
  await page.setInputFiles('#stem-import', wav);
  await page.waitForTimeout(8000);

  await page.locator('.stem-panel button', { hasText: '베이스 탭 자동 생성' }).click();
  await page.waitForFunction(
    () => !document.querySelector('.stem-panel .phase-line'),
    { timeout: 120000 },
  );
  await page.waitForTimeout(2000);

  const summary = await page.evaluate(() => {
    const hint = [...document.querySelectorAll('.stem-panel .hint')]
      .map((p) => p.textContent?.trim())
      .find((t) => t?.includes('음표'));
    return { hint: hint ?? null };
  });

  const tex = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const db = req.result;
          const all = db.transaction('songs').objectStore('songs').getAll();
          all.onsuccess = () => resolve(all.result[0]?.scoreData ?? null);
          all.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      }),
  );

  // Halving the tempo must rewrite the same notes at half speed without re-detecting anything.
  // It reads the notes back out of the last result, so a regression here shows up as the
  // score not changing at all, or as the note count collapsing.
  const bpmBefore = Number(/([\d.]+) BPM/.exec(summary.hint ?? '')?.[1] ?? 0);
  await page.locator('.stem-panel button', { hasText: '템포 ÷2' }).click();
  await page.waitForTimeout(2500);
  const afterHalving = await page.evaluate(() => {
    const hint = [...document.querySelectorAll('.stem-panel .hint')]
      .map((p) => p.textContent?.trim())
      .find((t) => t?.includes('음표'));
    return {
      hint: hint ?? null,
      bpmField: document.querySelector('.stem-panel input[type=number]')?.value ?? null,
    };
  });
  const bpmAfter = Number(/([\d.]+) BPM/.exec(afterHalving.hint ?? '')?.[1] ?? 0);

  await page.screenshot({ path: path.join(ROOT, 'autotab.png') });

  const frets = tex ? [...tex.matchAll(/\b(\d+)\.(\d)\b/g)].map((m) => `${m[1]}.${m[2]}`) : [];
  const counts = {};
  for (const f of frets) counts[f] = (counts[f] ?? 0) + 1;

  report = {
    titleAfterAudio,
    summary,
    totalNotes: frets.length,
    fretCounts: counts,
    firstEight: frets.slice(0, 8),
    barCount: tex ? tex.split('\n').filter((l) => l.trim().endsWith('|')).length : 0,
    firstBarHasRest: tex
      ? /\br\b/.test(tex.split('\n').find((l) => l.trim().endsWith('|')) ?? '')
      : false,
    tempoRescale: { bpmBefore, bpmAfter, bpmField: afterHalving.bpmField },
    errors: errors.slice(0, 3),
  };
} finally {
  fs.rmSync(wav, { force: true });
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
}

const expected = ['0.4', '0.3', '0.2', '0.1'];
const rescale = report.tempoRescale ?? {};
const checks = {
  // The song must be named after the audio file, not "새 곡" or the starter exercise.
  titleFromFilename: report.titleAfterAudio === '.autotab-test',
  producedNotes: report.totalNotes >= 8,
  // Every note in this line is an open string, so nothing else should appear.
  onlyOpenStrings: Object.keys(report.fretCounts ?? {}).every((f) => expected.includes(f)),
  foundAllFourStrings: expected.every((f) => (report.fretCounts?.[f] ?? 0) > 0),
  // The score must be long enough to play the whole recording, or playback stops early.
  // At 120 BPM a 4/4 bar lasts 2s, and the line is 4 notes x 0.5s x 4 repeats = 8s.
  scoreCoversAudio:
    report.barCount >= (LEAD_SECONDS + LINE.length * NOTE_SECONDS * REPEATS) / 2,
  // The lead-in must surface as rests at the top of bar 1 — notes shifted to their true
  // absolute slots — or the tab starts before the recording does and the cursor lies.
  leadInBecomesRests: report.firstBarHasRest === true,

  // Half and double are the same grid, so the onsets can never choose between them. The user
  // can, in one click, and it must actually take effect and pin the BPM field so the next run
  // keeps the choice.
  halvingTempoWorks:
    rescale.bpmBefore > 0 && Math.abs(rescale.bpmAfter - rescale.bpmBefore / 2) < 1,
  halvingPinsTheBpmField: Number(rescale.bpmField) > 0,

  noPageErrors: (report.errors ?? []).length === 0,
};

console.log(JSON.stringify({ report, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 자동 채보 통과' : '\n❌ 자동 채보 실패');
process.exit(pass ? 0 : 1);
