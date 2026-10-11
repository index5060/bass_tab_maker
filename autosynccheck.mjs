/**
 * End-to-end check of "이 곡에 기존 악보 넣기": an existing tab, synced to the recording
 * automatically.
 *
 * One of the evaluation songs (eval/songs/punk, original material) is rendered in Node with
 * alphaTab's synthesizer: the full band as "the recording", with silence in front of it, and
 * the bass alone as its bass stem (the import path; no separation model to download). The
 * same song's tab is exported as a Guitar Pro file — with the bass as the last track, so the
 * app has to find it — and put into the song through the sync panel. Every bar line the app
 * saves must land within 40ms of where that bar really starts in the recording.
 *
 *   node autosynccheck.mjs
 *   PREVIEW=1 node autosynccheck.mjs     (against the production build)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as alphaTab from '@coderline/alphatab';
import { parseTex, renderTex, SAMPLE_RATE } from './eval/lib/render.mjs';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5341);
const LEAD_MS = 1200;

/** The tab with its bass track moved to the end: Guitar, Drums, Bass. */
function bassLast(tex) {
  const at = tex.indexOf('\\track');
  const head = tex.slice(0, at);
  const tracks = tex.slice(at).split(/(?=\\track )/);
  const bass = tracks.findIndex((t) => t.startsWith('\\track "Bass"'));
  const [moved] = tracks.splice(bass, 1);
  const lastBar = (t) => t.trimEnd();
  return head + [...tracks.map(lastBar), lastBar(moved)].join('\n') + '\n';
}

/** Where each bar starts in a recording of `tex` with `leadMs` of silence first (ms). */
function barTimes(tex, leadMs) {
  const { score } = parseTex(tex);
  let t = leadMs;
  let bpm = score.tempo || 120;
  return score.masterBars.map((mb) => {
    if (mb.tempoAutomations.length) bpm = mb.tempoAutomations[0].value;
    const start = t;
    t += (mb.timeSignatureNumerator * (4 / mb.timeSignatureDenominator) * 60000) / bpm;
    return start;
  });
}

/** 16-bit mono WAVs at one shared gain, so that mix minus bass really is the band. */
function writeWavs(files) {
  let peak = 0;
  for (const { samples } of files) for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0.99 ? 0.99 / peak : 1;
  for (const { file, samples } of files) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(samples[i] * gain * 32767), i * 2);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVE', 8);
    head.write('fmt ', 12);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(SAMPLE_RATE, 24);
    head.writeUInt32LE(SAMPLE_RATE * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36);
    head.writeUInt32LE(data.length, 40);
    fs.writeFileSync(file, Buffer.concat([head, data]));
  }
}

const truth = fs.readFileSync(path.join(ROOT, 'eval', 'songs', 'punk', 'truth.atex'), 'utf8');
const mixWav = path.join(ROOT, '.autosync-test.wav');
const bassWav = path.join(ROOT, '.autosync-test-bass.wav');
const tabFile = path.join(ROOT, '.autosync-test.gp');

const recording = renderTex(truth, { leadMs: LEAD_MS });
const bass = renderTex(truth, { tracks: ['Bass'], leadMs: LEAD_MS });
writeWavs([
  { file: mixWav, samples: recording },
  { file: bassWav, samples: bass },
]);
const { score: tabScore, settings: tabSettings } = parseTex(bassLast(truth));
fs.writeFileSync(tabFile, new alphaTab.exporter.Gp7Exporter().export(tabScore, tabSettings));
const bassTrackIndex = tabScore.tracks.findIndex((t) => t.name === 'Bass');
const truthMs = barTimes(truth, LEAD_MS);

// --strictPort: a server left over on this port would otherwise be what gets tested, while the
// new one quietly takes the next port. Detached, so the whole group (npx and vite) is stopped.
const server = spawn(
  'npx',
  process.env.PREVIEW ? ['vite', 'preview', '--port', String(PORT), '--strictPort'] : ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, detached: true },
);
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
};
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('서버 타임아웃')), 90000);
  const onData = (b) => {
    if (/ready in|Local:/i.test(b.toString())) {
      clearTimeout(t);
      setTimeout(resolve, 1500);
    }
    if (/already in use|EADDRINUSE/i.test(b.toString())) reject(new Error(`포트 ${PORT}을 다른 서버가 쓰고 있습니다`));
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
});

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(40000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const dialogs = [];
page.on('dialog', (d) => {
  dialogs.push(d.message());
  void d.accept();
});

let report = {};
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 30000 });

  // The recording, through "원본 음원" in the top bar; then its bass stem, as imported.
  await page.setInputFiles('.topbar-actions input[accept*="audio"]', mixWav);
  await page.waitForTimeout(3000);
  await page.locator('.local-import summary').click();
  await page.setInputFiles('#stem-import', bassWav);
  await page.waitForFunction(() => document.body.textContent?.includes('스템 있음'), undefined, { timeout: 60000 });

  // The tab, through the sync panel.
  const started = Date.now();
  await page.setInputFiles('#score-insert', tabFile);
  await page.waitForFunction(
    () => [...document.querySelectorAll('.auto-sync .hint')].some((p) => /자동 싱크:|실패|없습니다/.test(p.textContent ?? '')),
    undefined,
    { timeout: 180000 },
  );
  const seconds = (Date.now() - started) / 1000;
  await page.waitForTimeout(1500);

  const panel = await page.evaluate(() =>
    [...document.querySelectorAll('.auto-sync .hint')].map((p) => p.textContent?.trim() ?? ''),
  );
  const saved = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('bass-practice');
        req.onsuccess = () => {
          const all = req.result.transaction('songs').objectStore('songs').getAll();
          all.onsuccess = () => {
            const song = all.result.find((s) => s.title === '.autosync-test');
            resolve(
              song
                ? { scoreKind: song.scoreKind, trackIndex: song.trackIndex, fileName: song.scoreFileName, anchors: song.syncAnchors }
                : null,
            );
          };
        };
        req.onerror = () => resolve(null);
      }),
  );
  const trackShown = await page.evaluate(() => document.querySelector('.track-list .on')?.textContent?.trim() ?? null);
  await page.screenshot({ path: path.join(ROOT, 'autosync.png') });

  const barTicks = 4 * 960;
  const barAnchors = (saved?.anchors ?? []).filter((a) => a.synthTick % barTicks === 0);
  const errorsMs = barAnchors.map((a) => Math.abs(a.audioMs - truthMs[a.barIndex]));
  report = {
    seconds,
    panel,
    dialogs,
    scoreKind: saved?.scoreKind,
    fileName: saved?.fileName,
    trackIndex: saved?.trackIndex,
    trackShown,
    anchors: saved?.anchors?.length ?? 0,
    barAnchors: barAnchors.length,
    worstErrorMs: Math.round(Math.max(0, ...errorsMs)),
    medianErrorMs: Math.round([...errorsMs].sort((a, b) => a - b)[errorsMs.length >> 1] ?? NaN),
    firstBars: barAnchors.slice(0, 8).map((a) => [a.barIndex + 1, Math.round(a.audioMs), Math.round(truthMs[a.barIndex])]),
    errors: errors.slice(0, 3),
  };
} finally {
  for (const f of [mixWav, bassWav, tabFile]) fs.rmSync(f, { force: true });
  await browser.close().catch(() => {});
  stopServer();
}

const agreement = Number(/일치도 (\d+)%/.exec((report.panel ?? []).join(' '))?.[1] ?? 0);
const checks = {
  // The file went into the open song, as a Guitar Pro score, without a question to answer.
  scoreReplaced: report.scoreKind === 'gp' && report.fileName === '.autosync-test.gp',
  noQuestionsAsked: (report.dialogs ?? []).length === 0,
  // Opened on the bass track, though it is the last of three.
  bassTrackChosen: report.trackIndex === bassTrackIndex && report.trackShown === 'Bass',
  // Every bar line anchored...
  everyBarAnchored: report.barAnchors === truthMs.length,
  // ...where the bar really starts — the six bars of rests at the top included.
  barLinesWithin40ms: report.barAnchors > 0 && report.worstErrorMs <= 40,
  saysHowWellItMatched: agreement >= 80,
  noPageErrors: (report.errors ?? []).length === 0,
};

console.log(JSON.stringify({ report, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 기존 악보 자동 싱크 통과' : '\n❌ 기존 악보 자동 싱크 실패');
process.exit(pass ? 0 : 1);
