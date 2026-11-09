/**
 * Score the transcription on Slakh2100 songs: real-song arrangements, rendered with
 * production-quality sampled instruments, each with its bass part as MIDI — the correct
 * answer, note for note.
 *
 * The test songs in eval/songs are written for the engine's own conditions; these are not.
 * They are thousands of songs' worth of arrangements nobody here chose, with their own
 * tempos, swing, fills and bass sounds, which is what a recording off YouTube will be like.
 *
 * Data: BabySlakh (the first 20 Slakh2100 songs, 16kHz, CC BY 4.0, zenodo.org/records/4603870),
 * unpacked into eval/data/babyslakh_16k (not committed). Audio is brought to 44.1kHz with
 * ffmpeg, the rate the app decodes stems at.
 *
 * Separation is taken as perfect here — the bass stem as rendered, and everything else summed
 * as the band — so the score is the transcription's own; a "bleed" condition puts some of the
 * band into the bass stem the way a real separation does.
 *
 *   EVAL_ONLY=eval/slakh.eval.ts npm run eval
 *   SLAKH_ONLY=Track00003 ...      (one song)
 */
import { it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Midi } from '@tonejs/midi';
import { analyseTab, type TabAnalysis } from '../src/lib/tab';
import { slotTimesFor } from '../src/lib/tab/notes';
import { detectPitch } from '../src/lib/pitch';

const ROOT = path.join(import.meta.dirname, 'data', 'babyslakh_16k');
const RATE = 44100;
/** Onset tolerance, as in mir_eval's note transcription metric. */
const ONSET_TOLERANCE = 0.05;
/** Beat tolerance, as in mir_eval's beat F-measure. */
const BEAT_TOLERANCE = 0.07;

interface Stem {
  id: string;
  instClass: string;
  program: number;
  isDrum: boolean;
  /** Has audio (and MIDI): stems that never sounded are listed too. */
  rendered: boolean;
}

/** The stems listed in a Slakh metadata.yaml (a fixed, flat layout: no YAML library needed). */
function readStems(file: string): Stem[] {
  const stems: Stem[] = [];
  let current: Stem | null = null;
  let inStems = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^stems:/.test(line)) {
      inStems = true;
      continue;
    }
    if (!inStems) continue;
    if (/^\S/.test(line)) break;
    const stem = /^ {2}(S\d+):\s*$/.exec(line);
    if (stem) {
      current = { id: stem[1], instClass: '', program: -1, isDrum: false, rendered: false };
      stems.push(current);
      continue;
    }
    const field = /^ {4}(\w+):\s*(.*)$/.exec(line);
    if (!field || !current) continue;
    const [, key, value] = field;
    if (key === 'inst_class') current.instClass = value.trim();
    if (key === 'program_num') current.program = Number(value);
    if (key === 'is_drum') current.isDrum = value.trim() === 'true';
    if (key === 'audio_rendered') current.rendered = value.trim() === 'true';
  }
  return stems;
}

/** Mono samples at 44.1kHz, through ffmpeg. */
function readAudio(file: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}

/**
 * Octaves between a stem's MIDI and what it sounds: Slakh writes some basses an octave above
 * their sound (the way bass is notated), and its renderer plays them where they sound.
 * Measured on the stem itself — YIN in the middle of its longer notes, the median rounded to
 * whole octaves — not with the engine under test, so it cannot flatter it.
 * (Measured: Track00001's MIDI 50 sounds at 73.5Hz, an octave down; its harmonics at 147 and
 * 220Hz.)
 */
function soundingShift(audio: Float32Array, notes: Array<{ time: number; duration: number; midi: number }>): number {
  const shifts: number[] = [];
  for (const n of notes.filter((n) => n.duration > 0.15).slice(0, 60)) {
    const at = Math.floor((n.time + Math.min(0.1, n.duration / 3)) * RATE);
    const result = detectPitch(audio.subarray(at, at + 4096), { sampleRate: RATE, minHz: 25, maxHz: 1000 });
    if (result.hz <= 0 || result.confidence < 0.8) continue;
    shifts.push(Math.round((69 + 12 * Math.log2(result.hz / 440) - n.midi) / 12) * 12);
  }
  shifts.sort((a, b) => a - b);
  return shifts.length ? shifts[shifts.length >> 1] : 0;
}

/**
 * The pitches a MIDI track sounds at each note's start: its note numbers moved by the pitch
 * bend in force then. Lakh files bend and slide, and the renderer plays the bends — counting
 * the written note made a bent note a wrong one (measured: Track00005, 188 bends, a seventh of
 * its notes "a semitone sharp"). The bend range is the file's own (RPN 0) where it sets one.
 */
function soundingNotes(midi: Midi): Array<{ time: number; duration: number; midi: number }> {
  return midi.tracks.flatMap((track) => {
    const cc = track.controlChanges;
    const rpnZero = (cc[101]?.[0]?.value ?? 1) === 0 && (cc[100]?.[0]?.value ?? 1) === 0;
    const range = rpnZero && cc[6]?.length ? Math.round(cc[6][0].value * 127) : 2;
    const bends = [...track.pitchBends].sort((a, b) => a.time - b.time);
    let k = -1;
    return [...track.notes]
      .sort((a, b) => a.time - b.time)
      .map((n) => {
        while (k + 1 < bends.length && bends[k + 1].time <= n.time + 0.03) k++;
        const bend = k >= 0 ? bends[k].value * range : 0;
        return { time: n.time, duration: n.duration, midi: n.midi + Math.round(bend) };
      });
  });
}

function sum(signals: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  for (const s of signals) for (let i = 0; i < Math.min(length, s.length); i++) out[i] += s[i];
  return out;
}

interface TimedNote {
  time: number;
  midi: number;
}

/**
 * Greedy one-to-one matching of predicted to true notes within the onset tolerance, closest
 * pairs first (within a few tenths of a percent of the optimal bipartite matching mir_eval uses).
 */
function matchCount(
  truth: TimedNote[],
  predicted: TimedNote[],
  same: (a: TimedNote, b: TimedNote) => boolean,
  tolerance = ONSET_TOLERANCE,
): number {
  const pairs: Array<[number, number, number]> = [];
  let j0 = 0;
  const sorted = [...predicted].sort((a, b) => a.time - b.time);
  const byTime = [...truth].sort((a, b) => a.time - b.time);
  for (let i = 0; i < byTime.length; i++) {
    while (j0 < sorted.length && sorted[j0].time < byTime[i].time - tolerance) j0++;
    for (let j = j0; j < sorted.length && sorted[j].time <= byTime[i].time + tolerance; j++) {
      if (same(byTime[i], sorted[j])) pairs.push([Math.abs(sorted[j].time - byTime[i].time), i, j]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const usedT = new Set<number>();
  const usedP = new Set<number>();
  let matched = 0;
  for (const [, i, j] of pairs) {
    if (usedT.has(i) || usedP.has(j)) continue;
    usedT.add(i);
    usedP.add(j);
    matched++;
  }
  return matched;
}

interface Counts {
  truth: number;
  predicted: number;
  note: number;
  onset: number;
  pitchClass: number;
}

const f1 = (matched: number, truth: number, predicted: number) =>
  truth + predicted === 0 ? 1 : (2 * matched) / (truth + predicted);

function score(truth: TimedNote[], predicted: TimedNote[]): Counts {
  return {
    truth: truth.length,
    predicted: predicted.length,
    note: matchCount(truth, predicted, (a, b) => a.midi === b.midi),
    onset: matchCount(truth, predicted, () => true),
    pitchClass: matchCount(truth, predicted, (a, b) => (a.midi - b.midi) % 12 === 0),
  };
}

/** Beat F-measure: tracked beats against the MIDI's, within ±70ms, inside the music. */
function beatF1(tracked: number[], midi: Midi, from: number, to: number): number {
  const ppq = midi.header.ppq;
  const truth: TimedNote[] = [];
  for (let tick = 0; ; tick += ppq) {
    const time = midi.header.ticksToSeconds(tick);
    if (time > to) break;
    if (time >= from) truth.push({ time, midi: 0 });
  }
  const predicted = tracked.filter((t) => t >= from - BEAT_TOLERANCE && t <= to + BEAT_TOLERANCE).map((time) => ({ time, midi: 0 }));
  return f1(matchCount(truth, predicted, () => true, BEAT_TOLERANCE), truth.length, predicted.length);
}

function predictedNotes(analysis: TabAnalysis): TimedNote[] {
  const times = slotTimesFor(analysis.beats, analysis.subdivision);
  return analysis.notes.map((n) => ({ time: times[n.startSlot], midi: n.midi })).filter((n) => Number.isFinite(n.time));
}

const CONDITIONS: Array<{ name: string; bleed: number }> = [
  { name: '분리 완벽', bleed: 0 },
  { name: '분리 번짐 -20dB', bleed: 0.1 },
];

const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(5);

it('Slakh 채점', () => {
  if (!fs.existsSync(ROOT)) {
    fs.mkdirSync(path.join(import.meta.dirname, 'out'), { recursive: true });
    fs.writeFileSync(path.join(import.meta.dirname, 'out', 'slakh-report.txt'), `\n${ROOT} 없음 — eval/slakh.eval.ts 머리말 참고\n`);
    return;
  }
  const only = process.env.SLAKH_ONLY;
  const tracks = fs
    .readdirSync(ROOT)
    .filter((t) => /^Track\d+$/.test(t) && (!only || t === only))
    .sort();
  const rows: string[] = [];
  const totals = new Map<string, Counts & { beat: number[] }>();

  for (const track of tracks) {
    const dir = path.join(ROOT, track);
    // BabySlakh's metadata says audio_rendered: false for every stem; the files say otherwise.
    const stems = readStems(path.join(dir, 'metadata.yaml')).map((s) => ({
      ...s,
      rendered: fs.existsSync(path.join(dir, 'stems', `${s.id}.wav`)) && fs.existsSync(path.join(dir, 'MIDI', `${s.id}.mid`)),
    }));
    // A "bass" stem whose notes are chords is a part played on a bass sound, not a bass line
    // (Lakh labels parts by program): a single-line tab cannot be right about it, nor wrong.
    // Measured: Track00012 S10 and Track00013 S01, half their notes overlapping, up to MIDI 84.
    const midiOf = (s: Stem) => new Midi(fs.readFileSync(path.join(dir, 'MIDI', `${s.id}.mid`)));
    const chordal = (s: Stem) => {
      const notes = midiOf(s).tracks.flatMap((t) => t.notes).sort((a, b) => a.time - b.time);
      const overlapping = notes.filter((n, i) => i > 0 && n.time < notes[i - 1].time + notes[i - 1].duration - 0.02).length;
      return overlapping > 0.2 * notes.length;
    };
    const bassStems = stems.filter((s) => s.rendered && !s.isDrum && s.instClass === 'Bass' && !chordal(s));
    const skipped = stems.filter((s) => s.rendered && !s.isDrum && s.instClass === 'Bass' && chordal(s)).map((s) => s.id);
    if (!bassStems.length) {
      rows.push(`${track}  베이스 없음`);
      continue;
    }
    const audio = new Map(stems.filter((s) => s.rendered).map((s) => [s.id, readAudio(path.join(dir, 'stems', `${s.id}.wav`))]));
    const length = Math.max(...[...audio.values()].map((a) => a.length));
    const bassClean = sum(bassStems.map((s) => audio.get(s.id)!), length);
    // The chordal "bass" stems are part of the band: they are heard, just not as the bass line.
    const band = sum(stems.filter((s) => s.rendered && !bassStems.includes(s)).map((s) => audio.get(s.id)!), length);

    const midis = bassStems.map(midiOf);
    const sounding = midis.map(soundingNotes);
    const shifts = bassStems.map((s, k) => soundingShift(audio.get(s.id)!, sounding[k]));
    const truth: TimedNote[] = sounding
      .flatMap((notes, k) => notes.map((n) => ({ time: n.time, midi: n.midi + shifts[k] })))
      .sort((a, b) => a.time - b.time);
    const firstNote = truth[0]?.time ?? 0;
    const lastNote = truth[truth.length - 1]?.time ?? 0;
    const midiBpm = midis[0].header.tempos[0]?.bpm ?? 0;
    const programs = bassStems.map((s) => s.program).join('+');

    for (const condition of CONDITIONS) {
      const bass = condition.bleed ? bassClean.map((v, i) => v + condition.bleed * band[i]) : bassClean;
      const started = Date.now();
      const analysis = analyseTab({ bass, band, sampleRate: RATE });
      const predicted = predictedNotes(analysis);
      const counts = score(truth, predicted);
      const beat = beatF1(analysis.beats.slice(analysis.firstTracked, analysis.lastTracked + 1), midis[0], firstNote, lastNote);
      const total = totals.get(condition.name) ?? { truth: 0, predicted: 0, note: 0, onset: 0, pitchClass: 0, beat: [] };
      total.truth += counts.truth;
      total.predicted += counts.predicted;
      total.note += counts.note;
      total.onset += counts.onset;
      total.pitchClass += counts.pitchClass;
      total.beat.push(beat);
      totals.set(condition.name, total);
      rows.push(
        `${track} ${condition.name.padEnd(12)} 음 F1 ${pct(f1(counts.note, counts.truth, counts.predicted))}` +
          ` · 시작만 ${pct(f1(counts.onset, counts.truth, counts.predicted))}` +
          ` · 음이름 ${pct(f1(counts.pitchClass, counts.truth, counts.predicted))}` +
          ` · 박 ${pct(beat)} · 정답 ${String(counts.truth).padStart(4)} 예측 ${String(counts.predicted).padStart(4)}` +
          ` · 템포 ${analysis.bpm.toFixed(0)}/${midiBpm.toFixed(0)} · ${analysis.meter.beatsPerBar}/4 · 프로그램 ${programs}` +
          ` · MIDI→소리 ${shifts.map((v) => (v > 0 ? `+${v}` : String(v))).join(',')}` +
          (skipped.length ? ` · 화음 스템 ${skipped.join(',')} 제외` : '') +
          ` (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
    }
  }

  const summary = [...totals.entries()].map(
    ([name, t]) =>
      `${name.padEnd(12)} 음 F1 ${pct(f1(t.note, t.truth, t.predicted))} · 시작만 ${pct(f1(t.onset, t.truth, t.predicted))}` +
      ` · 음이름 ${pct(f1(t.pitchClass, t.truth, t.predicted))} · 박 평균 ${pct(t.beat.reduce((a, b) => a + b, 0) / Math.max(1, t.beat.length))}` +
      ` · 정답 ${t.truth} 예측 ${t.predicted}`,
  );
  const report = ['', 'Slakh (BabySlakh) — 음은 시작 ±50ms·음높이 일치, 박은 ±70ms', ...rows, '', '전체 (곡을 합쳐 셈)', ...summary, ''].join('\n');
  fs.mkdirSync(path.join(import.meta.dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(import.meta.dirname, 'out', 'slakh-report.txt'), report);
});
