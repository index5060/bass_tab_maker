/**
 * Does the playback line actually show up?
 *
 * alphaTab creates .at-cursor-bar / .at-cursor-beat and moves them correctly even with no
 * styling at all, so "the cursor exists and has the right transform" is NOT enough to prove
 * anything is visible. The real assertion is that their computed background is not
 * transparent, and that the beat cursor's transform changes while playing.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5240);

const server = spawn('npx', ['vite', '--port', String(PORT)], { cwd: ROOT });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('서버 타임아웃')), 60000);
  const onData = (b) => {
    if (/ready in/i.test(b.toString())) {
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForSelector('.at-container svg, .at-container canvas', { timeout: 25000 });
await page.waitForFunction(() => {
  const b = document.querySelector('.btn-play');
  return b && !b.disabled;
}, { timeout: 35000 });

const readCursors = () =>
  page.evaluate(() => {
    const grab = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        exists: true,
        background: cs.backgroundColor,
        transform: cs.transform,
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      };
    };
    return { bar: grab('.at-cursor-bar'), beat: grab('.at-cursor-beat') };
  });

const before = await readCursors();
await page.locator('.btn-play').click();
// One bar of the demo (90 BPM, 4/4) is 2.67s, and playback takes a moment to actually
// start (audio context resume + synth buffer priming). Sample far enough apart that a bar
// boundary is guaranteed to be crossed, otherwise this test fails on timing, not on a bug.
await page.waitForTimeout(2000);
const during1 = await readCursors();
await page.waitForTimeout(6000);
const during2 = await readCursors();

await page.screenshot({ path: path.join(ROOT, 'cursor.png') });
// A tight crop of the first system so the line is unmistakable.
const box = await page.locator('.at-container').boundingBox();
if (box) {
  await page.screenshot({
    path: path.join(ROOT, 'cursor-zoom.png'),
    clip: { x: box.x, y: box.y + 120, width: Math.min(box.width, 1050), height: 220 },
  });
}
await page.locator('.btn-play').click();
await browser.close();
server.kill('SIGTERM');

const transparent = (c) => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
const checks = {
  barExists: !!during1.bar?.exists,
  beatExists: !!during1.beat?.exists,
  barPainted: !transparent(during1.bar?.background),
  beatPainted: !transparent(during1.beat?.background),
  beatHasSize: (during1.beat?.width ?? 0) > 0 && (during1.beat?.height ?? 0) > 0,
  beatMovesWhilePlaying: during1.beat?.transform !== during2.beat?.transform,
  barAdvancesAcrossBars: during1.bar?.transform !== during2.bar?.transform,
};

console.log(JSON.stringify({ before, during1, during2, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\n✅ 재생 커서 통과' : '\n❌ 재생 커서 실패');
process.exit(pass ? 0 : 1);
