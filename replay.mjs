/**
 * Re-write a 채보 진단 JSON as a tab, with the bar layout changed if asked.
 *
 * The export holds everything the analysis heard — beats, notes on the beat grid, and the
 * evidence for where bar 1 is. Everything after that (bars, strings and frets, the alphaTex)
 * runs again here in milliseconds, against a real song, as many times as it takes, without
 * the audio or the minutes of separation behind it.
 *
 * It calls the shipped `writeTabFrom`, not a copy of it. A replay harness that reimplements
 * the logic it is measuring will happily report that a bug is fixed.
 *
 *   node replay.mjs diag.json [--metre 3] [--phase 2]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const file = process.argv[2] ?? 'diag.json';
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > -1 ? Number(process.argv[at + 1]) : undefined;
};

const OUT = path.join(import.meta.dirname, '.replay-build');
fs.rmSync(OUT, { recursive: true, force: true });
try {
  execFileSync(
    'npx',
    [
      'tsc',
      'src/lib/tab/index.ts',
      '--outDir',
      OUT,
      '--module',
      'esnext',
      '--target',
      'es2022',
      '--moduleResolution',
      'bundler',
      '--skipLibCheck',
      '--ignoreConfig',
    ],
    { cwd: import.meta.dirname, stdio: ['ignore', 'ignore', 'ignore'] },
  );
} catch {
  // tsc still emits when only types complain; `npm run build` is what guards types for real.
}
const entry = fs.existsSync(path.join(OUT, 'tab', 'index.js')) ? path.join(OUT, 'tab') : OUT;
if (!fs.existsSync(path.join(entry, 'index.js'))) {
  console.error('컴파일 실패 — npm run build로 원인을 확인하세요.');
  process.exit(1);
}
// tsc emits .js with extensionless relative imports; node needs both fixed.
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
for (const p of walk(OUT)) {
  if (!p.endsWith('.js')) continue;
  const fixed = fs.readFileSync(p, 'utf8').replace(/from '(\.\.?\/[\w/.]+?)'/g, (_, spec) => `from '${spec}.mjs'`);
  fs.writeFileSync(p.replace(/\.js$/, '.mjs'), fixed);
  fs.rmSync(p);
}

const { writeTabFrom } = await import(path.join(entry, 'index.mjs'));
const diag = JSON.parse(fs.readFileSync(file, 'utf8'));
const tab = writeTabFrom(diag, {
  title: diag.title ?? 'replay',
  beatsPerBar: arg('--metre') ?? diag.layout?.beatsPerBar,
  downbeatPhase: arg('--phase') ?? (arg('--metre') ? undefined : diag.layout?.downbeatPhase),
});

console.log(`곡           ${diag.title}`);
console.log(`박           ${diag.beats.length}개 (실제로 들린 것 ${diag.lastTracked - diag.firstTracked + 1}개, 박자 출처: ${diag.beatSource})`);
console.log(`템포         ${diag.bpm.toFixed(2)} BPM → 악보 ${tab.bpm}`);
for (const t of diag.tempos ?? []) {
  console.log(`  후보 ${t.bpm.toFixed(1)}: 자기상관 ${t.autocorrelation.toFixed(2)} · 드럼 ${t.drums.toFixed(2)} · 뒷박/박 ${t.offbeats.toFixed(2)} → ${t.total.toFixed(2)}`);
}
console.log(`마디         ${tab.beatsPerBar}/4, ${tab.downbeatPhase}번 박이 1박 (확신도 ${diag.meter.confidence.toFixed(2)})`);
for (const c of [...diag.meter.candidates].sort((a, b) => b.score - a.score).slice(0, 4)) {
  console.log(`  ${c.beatsPerBar}/4 · ${c.phase}번 박: 드럼 ${c.drum.toFixed(2)} · 베이스 ${c.bass.toFixed(2)} → ${c.score.toFixed(2)}`);
}
console.log(`음표         ${tab.notes.length}개 · 튜닝 ${diag.tuningCents.toFixed(0)}센트`);

const bars = tab.alphaTex.split('\n').filter((l) => l.trim().endsWith('|'));
// Skip the empty intro bars — the interesting question is what the playing looks like.
const firstPlayed = Math.max(0, bars.findIndex((b) => /\d\.\d/.test(b)));
console.log(`\n${firstPlayed + 1}마디부터 8마디:`);
bars.slice(firstPlayed, firstPlayed + 8).forEach((bar, i) => console.log(`  ${String(firstPlayed + i + 1).padStart(3)} ${bar.trim()}`));
console.log(`\n총 ${bars.length}마디`);
fs.rmSync(OUT, { recursive: true, force: true });
