/**
 * Replay a 채보 진단 JSON through the real notes->tab pipeline.
 *
 * Accuracy work was guesswork until this existed. The audio is gone, the separation took
 * minutes, and the only way to tell whether a change helped was to run the whole chain again
 * and squint at the rendered tab. The diagnostic export already holds every note the detector
 * heard, with times and confidences — which is exactly the input to everything downstream. So
 * the second half of the pipeline can be re-run in milliseconds, as many times as it takes,
 * against a real song instead of a synthetic fixture.
 *
 * It calls the shipped `notesToAutoTab`, not a copy of it. A replay harness that reimplements
 * the logic it is measuring will happily report that a bug is fixed.
 *
 *   node replay.mjs diag.json [--bpm 146]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const file = process.argv[2] ?? 'diag.json';
const bpmArg = process.argv.indexOf('--bpm');
const userBpm = bpmArg > -1 ? Number(process.argv[bpmArg + 1]) : undefined;

const OUT = path.join(import.meta.dirname, '.replay-build');
fs.rmSync(OUT, { recursive: true, force: true });
try {
  execFileSync(
    'npx',
    [
      'tsc',
      'src/lib/autoTab.ts',
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
  // Compiling one file without the project config drags in modules typed loosely on purpose
  // (the ONNX backend). tsc still emits; only the exit code complains. `npm run build` is
  // what guards types for real.
}
if (!fs.existsSync(path.join(OUT, 'autoTab.js'))) {
  console.error('컴파일 실패 — npm run build로 원인을 확인하세요.');
  process.exit(1);
}
// tsc emits .js with extensionless relative imports; node needs both fixed.
for (const name of fs.readdirSync(OUT)) {
  fs.renameSync(path.join(OUT, name), path.join(OUT, name.replace(/\.js$/, '.mjs')));
}
for (const name of fs.readdirSync(OUT)) {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.mjs'"));
}

const { notesToAutoTab } = await import(path.join(OUT, 'autoTab.mjs'));

const diag = JSON.parse(fs.readFileSync(file, 'utf8'));
const notes = diag.detectedNotes.map((n) => ({
  midi: n.midi,
  startMs: n.startMs,
  endMs: n.endMs,
  confidence: n.confidence,
}));

const result = notesToAutoTab({
  notes,
  durationMs: diag.durationMs,
  title: diag.title,
  bpm: userBpm,
  // The export records which detector ran; older files predate the field, and a non-zero
  // frame count means the local pipeline produced them.
  engine: diag.engine ?? (diag.stats?.frames ? 'yin' : 'basic-pitch'),
});

const s = result.stats;
const slot = 60000 / result.bpm / 4;
const pct = (v) => `${(v * 100).toFixed(0)}%`;

console.log(`곡           ${diag.title}`);
console.log(`엔진         ${result.engine}`);
console.log(`음표         ${notes.length}개 입력 → ${result.noteCount}개 · 옥타브 교정 ${s.octavesRepaired}개`);
console.log(`이전 BPM     ${diag.bpm.toFixed(2)}   격자 오차 ±${diag.stats.gridErrorMs.toFixed(1)}ms`);
console.log(
  `새 BPM       ${result.bpm.toFixed(2)}   격자 오차 ±${s.gridErrorMs.toFixed(1)}ms  (16분음표의 ${pct(
    s.gridErrorMs / slot,
  )})`,
);
console.log(
  `격자 강도     ${s.tempoStrength.toFixed(3)}  (0.35 이상이면 실제로 물린 것) · 박 분할 ${
    s.subdivision
  }${s.subdivision === 3 ? ' (셔플)' : ''}`,
);
console.log(`음 있는 구간  ${pct(s.coverage)}  · 가장 긴 공백 ${(s.largestGapMs / 1000).toFixed(1)}초`);

const body = result.alphaTex
  .split('\n')
  .filter((l) => /^[:r\d]/.test(l))
  .join(' ');
// Skip the empty intro bars — the interesting question is what the playing looks like.
const bars = body.split('|');
const firstPlayed = Math.max(0, bars.findIndex((b) => /\d\.\d/.test(b)));
console.log(`\n${firstPlayed + 1}마디부터 8마디:`);
bars
  .slice(firstPlayed, firstPlayed + 8)
  .forEach((bar, i) => console.log(`  ${String(firstPlayed + i + 1).padStart(3)} |${bar.trim()}`));
console.log(`\n총 ${bars.length - 1}마디`);
