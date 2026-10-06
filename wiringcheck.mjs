/**
 * End-to-end wiring test for the two bugs found after the first real separation run:
 *
 *  1. A song saved by the autosave never appeared in "내 곡" — the list was only refreshed
 *     on mount, on "악보 열기" and on delete, which is not how songs usually get saved.
 *  2. Every recorded source was locked behind "싱크 앵커를 2개 이상 찍어야 합니다", so you
 *     could finish a five-minute separation and still not be allowed to hear the bass.
 *     Anchors align the tab cursor; they have nothing to do with whether audio can play.
 *
 * Both were invisible to the earlier tests because those never attached audio to a song.
 * This one walks the actual path: load a track, then import a stem, checking the UI at
 * each step.
 *
 *   node wiringcheck.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5300);

function writeTestWav(file, seconds = 2) {
  const sampleRate = 44100;
  const frames = sampleRate * seconds;
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

const readSources = (page) =>
  page.evaluate(() => {
    const btns = [...document.querySelectorAll('.segmented button')].map((b) => ({
      label: b.textContent?.trim(),
      disabled: b.disabled,
      title: b.title,
    }));
    // :first-child so the row's delete "×" button, which shares the .link class, is not
    // counted as a song title.
    const songs = [...document.querySelectorAll('.song-list li > .link:first-child')].map((a) =>
      a.textContent?.trim(),
    );
    return {
      buttons: btns,
      enabled: btns.filter((b) => !b.disabled).map((b) => b.label),
      songs,
      stemBadge: document.querySelector('.stem-panel .badge')?.textContent?.trim() ?? null,
    };
  });

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

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
// A fresh profile each run, so a leftover database cannot make the library check pass.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 25000 });

const before = await readSources(page);

const wav = path.join(ROOT, '.wiring-test.wav');
writeTestWav(wav);
await page.setInputFiles('input[accept*="audio"]', wav);
await page.waitForTimeout(3000); // decode + 600ms autosave debounce + list refresh

const afterAudio = await readSources(page);

// Importing the same file as the "bass stem" is enough to exercise the wiring: the derived
// minus-one track comes out silent, which is correct arithmetic for original - original.
await page.locator('.local-import summary').click();
await page.setInputFiles('#stem-import', wav);
await page.waitForTimeout(4000);

const afterStems = await readSources(page);
await page.screenshot({ path: path.join(ROOT, 'wiring.png') });

fs.rmSync(wav, { force: true });
await browser.close();
server.kill('SIGTERM');

const checks = {
  onlySynthBeforeAudio:
    before.enabled.length === 1 && before.enabled[0] === '신디',

  // Bug 2: loading audio must unlock the original immediately, with no anchors set.
  originalUnlockedWithoutAnchors: afterAudio.enabled.includes('원본'),
  stemsStillLockedWithoutStems:
    !afterAudio.enabled.includes('베이스만') && !afterAudio.enabled.includes('반주만'),
  noAnchorExcuseInTitles: !afterAudio.buttons.some((b) => /앵커/.test(b.title ?? '')),

  // Bug 1: the song must show up in the list once the autosave has run.
  songAppearsInLibrary: afterAudio.songs.length > 0,

  // Stems unlock the stem sources.
  stemsUnlockedAfterImport:
    afterStems.enabled.includes('베이스만') && afterStems.enabled.includes('반주만'),
  stemBadgeReady: afterStems.stemBadge === '준비됨',

  noPageErrors: consoleErrors.length === 0,
};

console.log(JSON.stringify({ before, afterAudio, afterStems, consoleErrors, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 소스/목록 배선 통과' : '\n❌ 배선 실패');
process.exit(pass ? 0 : 1);
