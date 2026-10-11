/**
 * End-to-end check of automatic tab generation.
 *
 * Feeds the app a synthesised bass line whose notes are known in advance — the four open
 * strings, one per beat at 120 BPM — and checks the generated tab actually says so.
 *
 * The audio doubles as its own "bass stem" through the import path, so this exercises the
 * whole chain (stems -> worker -> beats -> notes on the beat grid -> bars -> frets ->
 * alphaTex + sync anchors -> alphaTab) without downloading a 172MB model. The minus-bass stem
 * comes out silent, so the beat is found on the bass itself — the fallback path.
 *
 *   node autotabcheck.mjs
 *   PREVIEW=1 node autotabcheck.mjs     (against the production build)
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
// Real songs do not start at 0:00. Bar 1 has to start where the music does, and the sync
// anchors have to say so, or the recording plays 0.75s out of step with the tab.
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

// PREVIEW=1 runs it against the production build (npm run build first): the analysis worker
// is bundled separately there, and a worker that only works in dev is a broken feature.
const server = spawn('npx', process.env.PREVIEW ? ['vite', 'preview', '--port', String(PORT)] : ['vite', '--port', String(PORT)], { cwd: ROOT });
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
    undefined,
    { timeout: 120000 },
  );
  await page.waitForTimeout(2000);

  const summary = await page.evaluate(() => {
    const hint = [...document.querySelectorAll('.stem-panel .hint')]
      .map((p) => p.textContent?.trim())
      .find((t) => t?.includes('음표'));
    return { hint: hint ?? null };
  });

  const readSong = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('bass-practice');
          req.onsuccess = () => {
            const db = req.result;
            const all = db.transaction('songs').objectStore('songs').getAll();
            all.onsuccess = () => {
              const song = all.result.find((s) => s.title === '.autotab-test') ?? all.result[0];
              resolve({ tex: song?.scoreData ?? null, anchors: song?.syncAnchors ?? [] });
            };
            all.onerror = () => resolve({ tex: null, anchors: [] });
          };
          req.onerror = () => resolve({ tex: null, anchors: [] });
        }),
    );
  const saved = await readSong();
  const tex = saved.tex;

  // "Bar 1 starts a beat later" re-lays the same notes out instantly: the score must change
  // and the first bar line's anchor must move one beat (0.5s) into the recording.
  await page.locator('.stem-panel button', { hasText: '한 박 뒤로' }).click();
  await page.waitForTimeout(1500);
  const shifted = await readSong();
  await page.locator('.stem-panel button', { hasText: '한 박 앞으로' }).click();
  await page.waitForTimeout(1500);

  // Halving the tempo listens again with the beat period pinned, so the same notes come out
  // at half the tempo, and the BPM field keeps the choice for the next run.
  const bpmBefore = Number(/([\d.]+) BPM/.exec(summary.hint ?? '')?.[1] ?? 0);
  await page.locator('.stem-panel button', { hasText: '템포 ÷2' }).click();
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => !document.querySelector('.stem-panel .phase-line'), undefined, { timeout: 120000 });
  await page.waitForTimeout(1000);
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
    firstBar: tex ? (tex.split('\n').find((l) => l.trim().endsWith('|')) ?? '') : '',
    anchors: saved.anchors.length,
    firstAnchorMs: saved.anchors[0]?.audioMs ?? null,
    shiftedFirstAnchorMs: shifted.anchors[0]?.audioMs ?? null,
    shiftChangedScore: shifted.tex !== null && shifted.tex !== tex,
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
  // Bar 1 starts with the first note, not with the silence before it...
  barOneStartsWithTheMusic: /^\\ts \(4 4\) :4 0\.4/.test(report.firstBar ?? ''),
  // ...and its anchor says where that is in the recording: 0.75s in.
  barOneAnchoredAtTheLeadIn:
    report.anchors >= 2 && Math.abs((report.firstAnchorMs ?? 0) - LEAD_SECONDS * 1000) < 40,
  // Moving the bar line a beat later rewrites the tab and moves the anchor 0.5s.
  barShiftWorks:
    report.shiftChangedScore === true &&
    Math.abs((report.shiftedFirstAnchorMs ?? 0) - (report.firstAnchorMs ?? 0) - NOTE_SECONDS * 1000) < 40,

  // Which tempo level is "the" beat is partly a notation choice, so it is one click for the
  // user: it must take effect, and pin the BPM field so the next run keeps the choice.
  halvingTempoWorks:
    rescale.bpmBefore > 0 && Math.abs(rescale.bpmAfter - rescale.bpmBefore / 2) < 1,
  halvingPinsTheBpmField: Number(rescale.bpmField) > 0,

  noPageErrors: (report.errors ?? []).length === 0,
};

console.log(JSON.stringify({ report, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 자동 채보 통과' : '\n❌ 자동 채보 실패');
process.exit(pass ? 0 : 1);
