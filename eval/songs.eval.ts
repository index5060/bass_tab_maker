/**
 * Every song in eval/songs: render the correct tab as a band recording under each condition,
 * transcribe it with each pipeline, and score the result against the truth.
 *
 *   npm run eval
 *   SHOW=punk npm run eval     (every bar of one song, not just the first 12 of failing ones)
 */
import { it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — plain .mjs helpers shared with the Node scripts
import { renderTex } from './lib/render.mjs';
// @ts-expect-error — plain .mjs helpers shared with the Node scripts
import { scoreTab, barDiff } from './lib/score.mjs';
import { CONDITIONS } from './conditions';
import { tabPipeline, type PipelineInput } from './pipelines';

// eval/songs holds original test songs. eval/local (not committed) can hold more, e.g. a
// transcription of a real song read off a published tab, for checking against at home.
const SONG_DIRS = ['songs', 'local']
  .map((dir) => path.join(import.meta.dirname, dir))
  .filter((dir) => fs.existsSync(dir));
const SONGS = SONG_DIRS.flatMap((dir) => fs.readdirSync(dir).map((song) => ({ song, file: path.join(dir, song, 'truth.atex') })))
  .filter(({ file }) => fs.existsSync(file))
  .sort((a, b) => a.song.localeCompare(b.song));
const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(5);
const PIPELINES: Array<[string, (input: PipelineInput) => string]> = [['새 방식', tabPipeline]];
const ONLY = process.env.EVAL_PIPELINE;

it('채점표', () => {
  const rows: string[] = [];
  const details: string[] = [];
  const summary = new Map<string, number[]>();
  for (const { song, file } of SONGS) {
    const truth = fs.readFileSync(file, 'utf8');
    for (const condition of CONDITIONS) {
      const tex = condition.transform ? condition.transform(truth) : truth;
      const band: Float32Array = renderTex(tex, { tracks: ['Guitar', 'Drums'], leadMs: condition.leadMs });
      const cleanBass: Float32Array = renderTex(tex, { tracks: ['Bass'], leadMs: condition.leadMs });
      const bleed = condition.bleed ?? 0;
      const bassInBand = condition.bassInBand ?? 0;
      const bass = bleed > 0 ? cleanBass.map((v, i) => v + bleed * (band[i] ?? 0)) : cleanBass;
      const rest = bassInBand > 0 ? band.map((v, i) => v + bassInBand * (cleanBass[i] ?? 0)) : band;
      const input: PipelineInput = { bass, rest, sampleRate: 44100, title: song };
      for (const [name, run] of PIPELINES) {
        if (ONLY && name !== ONLY) continue;
        const started = Date.now();
        const predicted = run(input);
        const s = scoreTab(predicted, truth);
        const shift = s.bestShift.bars || s.bestShift.sixteenths ? `${s.bestShift.bars}마디${s.bestShift.sixteenths}칸→${pct(s.bestShift.f1)}` : '-';
        rows.push(
          `${song.padEnd(8)} ${condition.name.padEnd(12)} ${name.padEnd(6)} 음 ${String(s.predictedNotes).padStart(3)}/${String(s.truthNotes).padEnd(3)}` +
            ` 정확 ${pct(s.strict.f1)} ±16분 ${pct(s.loose.f1)} 프렛 ${pct(s.fretAgreement)} 옥타브 ${s.octaveErrors} 다른음 ${s.wrongPitch} 이동 ${shift} (${Date.now() - started}ms)`,
        );
        summary.set(name, [...(summary.get(name) ?? []), s.strict.f1]);
        if (name === '새 방식' && (s.strict.f1 < 0.95 || process.env.SHOW === song)) {
          details.push(`[${song} / ${condition.name} / ${name}]`, ...barDiff(predicted, truth, [...Array(process.env.SHOW === song ? 40 : 12).keys()]));
        }
      }
    }
  }
  const means = [...summary].map(([name, v]) => `${name} 평균 정확 ${pct(v.reduce((a, b) => a + b, 0) / v.length)} (최저 ${pct(Math.min(...v))})`);
  const report = ['', '정답 대비 점수', ...rows, '', ...means, '', ...details, ''].join('\n');
  fs.mkdirSync(path.join(import.meta.dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(import.meta.dirname, 'out', 'report.txt'), report);
});
