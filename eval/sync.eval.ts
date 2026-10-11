/**
 * Score the aligner: give it a tab and a recording of that tab, and see whether every bar
 * line lands where it really is in the recording.
 *
 * The recordings are the evaluation songs rendered under the same conditions as the
 * transcription test (lead-in silence, tempo drift, other bass sounds, separation bleed); the
 * tab handed to the aligner is always the plain truth — one tempo, no drift — the way a
 * published tab is. More cases test the warp itself: a tab that leaves out the intro the
 * recording has, a recording that plays one bar or a four-bar phrase more than the tab (or the
 * tab more than the recording), a tab whose tempo marking is half the real one, a tab written
 * in notes of half the value, and a transcription far worse than a good separation gives.
 *
 *   EVAL_ONLY=eval/sync.eval.ts npm run eval
 */
import { it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — plain .mjs helpers shared with the Node scripts
import { renderTex, parseTex } from './lib/render.mjs';
import { CONDITIONS, type Condition } from './conditions';
import { analyseTab, type GridNote } from '../src/lib/tab';
import { syncScore } from '../src/lib/autoSync';

const SONG_DIRS = ['songs', 'local']
  .map((dir) => path.join(import.meta.dirname, dir))
  .filter((dir) => fs.existsSync(dir));
const SONGS = SONG_DIRS.flatMap((dir) => fs.readdirSync(dir).map((song) => ({ song, file: path.join(dir, song, 'truth.atex') })))
  .filter(({ file }) => fs.existsSync(file))
  .sort((a, b) => a.song.localeCompare(b.song));

/** Every track's bars, as lines: [header lines, bar lines] per track. */
function splitTracks(tex: string) {
  const lines = tex.split('\n');
  const head: string[] = [];
  const tracks: Array<{ header: string[]; bars: string[] }> = [];
  for (const line of lines) {
    if (line.startsWith('\\track')) tracks.push({ header: [line], bars: [] });
    else if (!tracks.length) head.push(line);
    else if (line.trim().endsWith('|')) tracks[tracks.length - 1].bars.push(line);
    else tracks[tracks.length - 1].header.push(line);
  }
  return { head, tracks };
}
function joinTracks(parts: ReturnType<typeof splitTracks>): string {
  return [...parts.head, ...parts.tracks.flatMap((t) => [...t.header, ...t.bars])].join('\n');
}
/** Leave out the first `count` bars (keeping the time signature the first bar declared). */
function withoutFirstBars(tex: string, count: number): string {
  const parts = splitTracks(tex);
  for (const t of parts.tracks) {
    const ts = /\\ts \(\d+ \d+\)/.exec(t.bars[0] ?? '')?.[0];
    t.bars = t.bars.slice(count);
    if (ts && t.bars.length && !t.bars[0].includes('\\ts')) t.bars[0] = `${ts} ${t.bars[0]}`;
  }
  return joinTracks(parts);
}
/** Play bars `at`..`at + count - 1` twice (a repeat the tab does not have). */
function withBarsRepeated(tex: string, at: number, count = 1): string {
  const parts = splitTracks(tex);
  for (const t of parts.tracks) {
    const copies = t.bars.slice(at, at + count).map((b) => b.replace(/\\(ts|tempo) \S+( \S+)?\)?/g, '').trim());
    t.bars.splice(at + count, 0, ...copies);
  }
  return joinTracks(parts);
}
/** The same tab with its tempo marking halved (the beat written as a half note's worth). */
function withTempoMarkingHalved(tex: string): string {
  return tex.replace(/\\tempo (\d+)/, (_, bpm) => `\\tempo ${Math.round(Number(bpm) / 2)}`);
}

/**
 * For a recording that plays `extra` bars more than the tab, the recording bars each tab bar
 * may rightly be matched to. The extra bars repeat others, so where they were skipped is
 * ambiguous wherever the bass line repeats: any place `s` where skipping them leaves the
 * two lines identical (tab bar b on recording bar b before s, b + extra from s on) is right.
 */
function skipsOf(tab: string, recording: string, extra: number): (i: number) => number[] {
  const bass = (tex: string) => splitTracks(tex).tracks[0].bars.map((b) => b.replace(/\\(ts|tempo) \S+( \S+)?\)?/g, '').trim());
  const t = bass(tab);
  const r = bass(recording);
  const valid: number[] = [];
  for (let s = 0; s <= t.length; s++) {
    if (t.every((bar, b) => bar === r[b < s ? b : b + extra])) valid.push(s);
  }
  return (i) => [...new Set(valid.map((s) => (i < s ? i : i + extra)))];
}

/**
 * For a tab that has `extra` bars the recording does not play, the recording bars each tab bar
 * may rightly be matched to — none for a bar that is not played (any time is right for it).
 */
function deletionsOf(tab: string, recording: string, extra: number): (i: number) => number[] | null {
  const bass = (tex: string) => splitTracks(tex).tracks[0].bars.map((b) => b.replace(/\\(ts|tempo) \S+( \S+)?\)?/g, '').trim());
  const t = bass(tab);
  const r = bass(recording);
  const valid: number[] = [];
  for (let s = 0; s + extra <= t.length; s++) {
    if (t.every((bar, b) => b >= s && b < s + extra || bar === r[b < s ? b : b - extra])) valid.push(s);
  }
  return (i) => (valid.some((s) => i >= s && i < s + extra) ? null : [...new Set(valid.map((s) => (i < s ? i : i - extra)))]);
}

/** The same music written in notes of half the value, a beat to the eighth note. */
function withNoteValuesHalved(tex: string): string {
  const parts = splitTracks(tex);
  for (const t of parts.tracks) {
    if (t.bars.length && !t.bars[0].includes('\\ts')) t.bars[0] = `\\ts (4 4) ${t.bars[0]}`;
  }
  return joinTracks(parts)
    .replace(/:(1|2|4|8|16)(?=[\s{])/g, (_, d) => `:${Number(d) * 2}`)
    .replace(/\\ts \((\d+) 4\)/g, '\\ts ($1 8)')
    .replace(/\\tempo (\d+)/g, (_, bpm) => `\\tempo ${Number(bpm) * 2}`);
}

/** Where each bar of a rendered tex starts in its recording (s). */
function barTimes(tex: string, leadMs: number): number[] {
  const { score } = parseTex(tex);
  let t = leadMs / 1000;
  let bpm = score.tempo || 120;
  const out: number[] = [];
  for (const mb of score.masterBars) {
    if (mb.tempoAutomations.length) bpm = mb.tempoAutomations[0].value;
    out.push(t);
    t += (mb.timeSignatureNumerator * (4 / mb.timeSignatureDenominator) * 60) / bpm;
  }
  return out;
}

interface Case {
  name: string;
  recording: string;
  condition: Condition;
  tab: string;
  /** Recording bars that tab bar i may rightly be matched to; null: any (a bar not played). */
  mapBar: (i: number) => number[] | null;
  /** Spoil the transcription the aligner is given, as a poor separation would. */
  spoil?: (notes: GridNote[]) => GridNote[];
}

/**
 * A transcription far worse than the renders give: a quarter of the notes missed, a tenth an
 * octave off, a tenth a wrong note, and a stray note for every ten. Seeded, so runs compare.
 */
function spoilt(notes: GridNote[]): GridNote[] {
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: GridNote[] = [];
  for (const n of notes) {
    const r = random();
    if (r < 0.25) continue;
    if (r < 0.35) out.push({ ...n, midi: n.midi + (random() < 0.5 ? 12 : -12) });
    else if (r < 0.45) out.push({ ...n, midi: n.midi + 1 + Math.floor(random() * 11) });
    else out.push(n);
    if (random() < 0.1) {
      const at = n.startSlot + 1 + Math.floor(random() * 6);
      out.push({ startSlot: at, endSlot: at + 2, midi: 28 + Math.floor(random() * 24), confidence: 0.5 });
    }
  }
  return out.sort((a, b) => a.startSlot - b.startSlot);
}

it('악보 자동 싱크 채점', () => {
  const rows: string[] = [];
  const all: number[] = [];
  for (const { song, file } of SONGS) {
    const truth = fs.readFileSync(file, 'utf8');
    const leadingRests = splitTracks(truth).tracks[0].bars.findIndex((b) => /\d\.\d/.test(b));
    const cases: Case[] = CONDITIONS.map((condition) => ({
      name: condition.name,
      recording: condition.transform ? condition.transform(truth) : truth,
      condition,
      tab: truth,
      mapBar: (i) => [i],
    }));
    const cut = Math.max(1, leadingRests - 1);
    cases.push({ name: `악보에 앞 ${cut}마디 없음`, recording: truth, condition: CONDITIONS[1], tab: withoutFirstBars(truth, cut), mapBar: (i) => [i + cut] });
    const middle = Math.floor(splitTracks(truth).tracks[0].bars.length / 2);
    cases.push({
      name: '녹음에 한 마디 더',
      recording: withBarsRepeated(truth, middle),
      condition: CONDITIONS[1],
      tab: truth,
      mapBar: skipsOf(truth, withBarsRepeated(truth, middle), 1),
    });
    const phrase = Math.max(0, middle - 2);
    cases.push({
      name: '녹음에 네 마디 더',
      recording: withBarsRepeated(truth, phrase, 4),
      condition: CONDITIONS[1],
      tab: truth,
      mapBar: skipsOf(truth, withBarsRepeated(truth, phrase, 4), 4),
    });
    cases.push({ name: '악보 템포 표기 절반', recording: truth, condition: CONDITIONS[1], tab: withTempoMarkingHalved(truth), mapBar: (i) => [i] });
    cases.push({
      name: '악보에 네 마디 더',
      recording: truth,
      condition: CONDITIONS[1],
      tab: withBarsRepeated(truth, phrase, 4),
      mapBar: deletionsOf(withBarsRepeated(truth, phrase, 4), truth, 4),
    });
    cases.push({ name: '악보 음표 길이 절반', recording: truth, condition: CONDITIONS[1], tab: withNoteValuesHalved(truth), mapBar: (i) => [i] });
    cases.push({ name: '채보 엉망 (25% 놓침 등)', recording: truth, condition: CONDITIONS[1], tab: truth, mapBar: (i) => [i], spoil: spoilt });
    cases.push({
      name: '채보 엉망 + 네 마디 더',
      recording: withBarsRepeated(truth, phrase, 4),
      condition: CONDITIONS[1],
      tab: truth,
      mapBar: skipsOf(truth, withBarsRepeated(truth, phrase, 4), 4),
      spoil: spoilt,
    });

    for (const c of cases) {
      const band: Float32Array = renderTex(c.recording, { tracks: ['Guitar', 'Drums'], leadMs: c.condition.leadMs });
      const clean: Float32Array = renderTex(c.recording, { tracks: ['Bass'], leadMs: c.condition.leadMs });
      const bass = c.condition.bleed ? clean.map((v, i) => v + c.condition.bleed! * (band[i] ?? 0)) : clean;
      const rest = c.condition.bassInBand ? band.map((v, i) => v + c.condition.bassInBand! * (clean[i] ?? 0)) : band;
      const started = Date.now();
      const heard = analyseTab({ bass, band: rest, sampleRate: 44100 });
      const analysis = c.spoil ? { ...heard, notes: c.spoil(heard.notes) } : heard;
      // As the app does it: the tab read by alphaTab, played out by its MIDI generator.
      const { score, settings } = parseTex(c.tab);
      const result = syncScore(score, analysis, { settings })?.result;
      const truthTimes = barTimes(c.recording, c.condition.leadMs);
      const errors = (result?.bars ?? [])
        .map((b, i) => {
          const allowed = c.mapBar(i);
          return allowed ? Math.min(...allowed.map((r) => Math.abs(b.audioMs - (truthTimes[r] ?? NaN) * 1000))) : NaN;
        })
        .filter(Number.isFinite);
      const within = errors.filter((e) => e <= 40).length / Math.max(1, errors.length);
      const sorted = [...errors].sort((a, b) => a - b);
      all.push(within);
      rows.push(
        `${song.padEnd(8)} ${c.name.padEnd(18)} 마디 ${String(errors.length).padStart(3)} ±40ms 안 ${String(Math.round(within * 100)).padStart(3)}%` +
          ` 중앙 ${String(Math.round(sorted[sorted.length >> 1] ?? 0)).padStart(4)}ms 최대 ${String(Math.round(sorted[sorted.length - 1] ?? 0)).padStart(5)}ms` +
          ` 일치도 ${((result?.agreement ?? 0) * 100).toFixed(0)}% 4분음표=${result?.beatsPerQuarter}박 (${Date.now() - started}ms)`,
      );
    }
  }
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const report = ['', '악보 → 원곡 자동 싱크', ...rows, '', `평균: 마디선의 ${Math.round(mean * 100)}%가 ±40ms 안 (최저 ${Math.round(Math.min(...all) * 100)}%)`, ''].join('\n');
  fs.mkdirSync(path.join(import.meta.dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(import.meta.dirname, 'out', 'sync-report.txt'), report);
});
