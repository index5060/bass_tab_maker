/**
 * Bass stem (+ the rest of the band) in, bass tab out.
 *
 *   band ──→ beats (beats.ts, tempo.ts) ──────────┐
 *                                                ▼
 *   bass ──→ notes on the beat grid (notes.ts) ─→ downbeat & metre (meter.ts)
 *                                                ─→ strings & frets (frets.ts)
 *                                                ─→ alphaTex + sync anchors (write.ts)
 *
 * Split in two: `analyseTab` does the listening (seconds of work, run in a worker), and
 * `writeTabFrom` turns that into a tab (milliseconds). The split is what lets "bar 1 starts a
 * beat later" or "it is in 3, not 4" be answered instantly, from the same notes.
 *
 * Pure: arrays of samples in, text out. No browser APIs, so the whole thing runs in Node
 * against rendered test songs with known tabs (npm run eval) — which is how every number in
 * the comments of these files was measured.
 */

import { onsetStrength } from './beats';
import { decodeBassLine, slotTimesFor, type GridNote } from './notes';
import { findMeter, type Meter } from './meter';
import { findBeats, type BeatChoice } from './tempo';
import { assignFrets, type FrettedNote } from './frets';
import { writeTab, type BarAnchor } from './write';

export type { BarAnchor } from './write';
export type { FrettedNote } from './frets';
export type { GridNote } from './notes';
export type { Meter } from './meter';

export interface TabInput {
  /** The separated bass, mono. */
  bass: Float32Array;
  /** Everything else (or the full mix), mono — where the beat comes from. Null: use the bass. */
  band: Float32Array | null;
  sampleRate: number;
  /** A tempo the user knows. Pins the beat period; the beats are still tracked. */
  bpm?: number;
}

/** What was heard: beats, notes on them, and the evidence for where the bars go. */
export interface TabAnalysis {
  /** Beat times (s) over the whole recording; outside first..lastTracked they are extrapolated. */
  beats: number[];
  firstTracked: number;
  lastTracked: number;
  bpm: number;
  /** Notes on the grid of `beats`: slot = beat index × subdivision + position in the beat. */
  notes: GridNote[];
  subdivision: number;
  meter: Meter;
  /** How far the recording sits from A=440 (cents). */
  tuningCents: number;
  beatSource: 'band' | 'bass';
  /** The tempo octaves that were weighed (empty when the tempo was given). */
  tempos: BeatChoice['considered'];
  durationSeconds: number;
}

export type AnalysisStage = 'beats' | 'notes' | 'bars';

export interface TabResult {
  alphaTex: string;
  /** Recording time of each bar line, for syncing playback to the recording. */
  anchors: BarAnchor[];
  /** Tempo written at the start. */
  bpm: number;
  beatsPerBar: number;
  /** Which tracked beat became the first beat of a bar. */
  downbeatPhase: number;
  notes: FrettedNote[];
  /** Beat times (s), bar 1 starting at beat 0. */
  beats: number[];
  bars: number;
}

const SUBDIVISION = 4;

export function analyseTab(input: TabInput, onStage?: (stage: AnalysisStage) => void): TabAnalysis {
  const { bass, sampleRate } = input;
  const durationSeconds = bass.length / sampleRate;
  onStage?.('beats');
  const onset = onsetStrength(input.band ?? bass, sampleRate);
  const track = findBeats(onset, durationSeconds, { bpm: input.bpm, drums: input.band !== null });

  onStage?.('notes');
  const line = decodeBassLine(bass, sampleRate, track.beats, { subdivision: SUBDIVISION, band: input.band });

  onStage?.('bars');
  const meter = findMeter(track.beats, line.notes, SUBDIVISION, input.band ? onset : null, {
    first: track.firstTracked,
    last: track.lastTracked,
  });

  return {
    beats: track.beats,
    firstTracked: track.firstTracked,
    lastTracked: track.lastTracked,
    bpm: track.bpm,
    notes: line.notes,
    subdivision: SUBDIVISION,
    meter,
    tuningCents: line.tuningCents,
    beatSource: input.band ? 'band' : 'bass',
    tempos: track.considered,
    durationSeconds,
  };
}

/**
 * The tab for an analysis. `beatsPerBar` and `downbeatPhase` override what the analysis
 * decided; given a metre alone, its best-scoring "one" is used.
 */
export function writeTabFrom(
  analysis: TabAnalysis,
  options: { title: string; beatsPerBar?: number; downbeatPhase?: number },
): TabResult {
  const sub = analysis.subdivision;
  const m = options.beatsPerBar ?? analysis.meter.beatsPerBar;
  let phase = options.downbeatPhase;
  if (phase === undefined) {
    phase =
      m === analysis.meter.beatsPerBar
        ? analysis.meter.downbeatPhase
        : ([...analysis.meter.candidates].filter((c) => c.beatsPerBar === m).sort((a, b) => b.score - a.score)[0]?.phase ?? 0);
  }
  phase = ((phase % m) + m) % m;

  // Make beat 0 a downbeat. Beats before the first downbeat are a pickup: rather than drop
  // what is played there, extend the grid backwards so they become the end of bar 1.
  const pad = (m - phase) % m;
  const source = analysis.beats;
  const period = source.length > 1 ? source[1] - source[0] : 60 / analysis.bpm;
  const padding = Array.from({ length: pad }, (_, i) => source[0] - (pad - i) * period);
  let beats = [...padding, ...source];
  // ...but an empty bar that is over before anything has been played is not a bar of the
  // song. The grid reaches a beat or so before the first sound, so that a note right at the
  // start still has a slot; padded out to a full bar, that made an empty bar 1 and put the
  // whole song one bar late (measured, with and without silence in front of the music).
  // A real pickup — a fill or a lead-in note before bar 1 — has sound in it and stays.
  const slotTimes = slotTimesFor(source, sub);
  const firstNote = analysis.notes.length ? slotTimes[analysis.notes[0].startSlot] : Infinity;
  const firstSound = Math.min(source[analysis.firstTracked] ?? Infinity, firstNote);
  const noteBefore = (beat: number) => analysis.notes.some((n) => n.startSlot + pad * sub < beat * sub);
  let dropBars = 0;
  while (
    beats.length > (dropBars + 2) * m &&
    beats[(dropBars + 1) * m] <= firstSound + 0.05 &&
    !noteBefore((dropBars + 1) * m)
  ) {
    dropBars++;
  }
  beats = beats.slice(dropBars * m);
  const shift = (pad - dropBars * m) * sub;
  const notes: GridNote[] = analysis.notes
    .map((n) => ({ ...n, startSlot: n.startSlot + shift, endSlot: n.endSlot + shift }))
    .filter((n) => n.startSlot >= 0);

  const fretted = assignFrets(notes);
  const written = writeTab({
    title: options.title,
    notes: fretted,
    beats,
    beatsPerBar: m,
    subdivision: sub,
    trackedBeats: {
      first: analysis.firstTracked + pad - dropBars * m,
      last: analysis.lastTracked + pad - dropBars * m,
    },
  });

  return {
    alphaTex: written.alphaTex,
    anchors: written.anchors,
    bpm: written.bpm,
    beatsPerBar: m,
    downbeatPhase: phase,
    notes: fretted,
    beats,
    bars: written.bars,
  };
}

/** Both steps at once. */
export function transcribeTab(input: TabInput & { title: string }): TabResult {
  return writeTabFrom(analyseTab(input), { title: input.title });
}
