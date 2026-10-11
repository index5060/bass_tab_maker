/**
 * Line up an existing tab with a recording of it: where in the recording each bar starts.
 *
 * Far easier than transcribing, and far more reliable, because the notes are already known —
 * only their places are not. The recording is read exactly as for a transcription (beats
 * from the band, the bass on a sixteenth grid; see analyseTab), and then the tab's line is
 * matched against it a quarter note at a time with dynamic time warping:
 *
 *   tab, per quarter note:    | F . . F | A . . . | Db . . Db | A . . . | ...
 *   recording, per beat:      | F . . F | A . . . | Db . . Db | A . . . | ...
 *
 * Each pair is scored on the pitches that sound (pitch classes, so an octave slip of the
 * pitch detector still counts) and on where notes start. At the tab's bar lines the warp may
 * skip whole bars of either side — a phrase the recording plays twice, a repeat it leaves
 * out, a beat the tracker added — but pays for each skip and for every unit skipped, so it
 * keeps to the diagonal wherever the two agree. The tab may start and end anywhere in the
 * recording; bass played before or after it is paid for like any other skip, and more.
 *
 * How long a quarter note of the tab is in beats of the recording is tried, not assumed: a
 * song tracked at 66 for 132 has a quarter note every half beat, and the tab's tempo marking
 * cannot settle it — it is often wrong (measured: a tab marked at half its tempo, "fixed" by
 * tracking the beats again at that tempo, lined up nowhere).
 *
 * Measured on the evaluation songs (npm run eval, eval/sync.eval.ts): every bar line within
 * 40ms, across other bass sounds, separation bleed, tempo drift, an intro the tab leaves out,
 * a phrase played once more or once less, a tab in half the note values, and a transcription
 * with a quarter of its notes missed and a fifth wrong.
 */

import type { TabAnalysis } from './index';
import type { ScoreBar } from './scoreLine';

export interface AlignedBar {
  /** Index of the bar in the score. */
  barIndex: number;
  /** Playback tick of the bar line (repeats played out). */
  tick: number;
  /** Where that bar line is in the recording. */
  audioMs: number;
  /**
   * Where the bar's last beat ends in the recording: the next bar line, unless the recording
   * plays something the tab does not have in between.
   */
  endMs: number;
  /** 0..1: how well the tab and the recording agree over this bar. */
  agreement: number;
}

export interface AlignResult {
  bars: AlignedBar[];
  /** Beats of the recording that a quarter note of the tab turned out to be (0.5, 1 or 2). */
  beatsPerQuarter: number;
  /** 0..1 over the whole tab. Under ~0.5 the tab and the recording do not really match. */
  agreement: number;
}

/** Ticks per quarter note (alphaTab's, and the MIDI standard's). */
const QUARTER = 960;
/** Slots per unit: where a note starts is compared to the sixteenth. */
const SLOTS = 4;
/**
 * The recording grids tried, as [analysis slots per unit, first slot]: a quarter note is a
 * beat, half a beat, or two beats (which can start on either beat of the pair). The analysis
 * reads four slots per beat.
 */
const GRIDS: ReadonlyArray<readonly [number, number]> = [
  [4, 0],
  [2, 0],
  [8, 0],
  [8, 4],
];
/**
 * Cost of each unit one side skips: a beat the tracker missed or added, a bar the recording
 * plays that the tab does not, a repeat played more or fewer times. About what a poorly
 * matched beat costs (a mismatch costs up to 1), and per unit — any cheaper and the warp
 * matches only the easy parts and skips the rest (measured: a seven-bar intro skipped and the
 * tab 12 seconds off; a waltz whose sustained notes match at ~0.7 skipped almost entirely).
 */
const SKIP = 0.6;
/** Longest stretch one side may skip in one go, in units (sixteen bars of four). */
const JUMP = 64;
/**
 * And a cost for each skip, however long. Skipping a stretch in one go must be cheaper than
 * in pieces: where a riff repeats, a bar the recording plays twice can otherwise be skipped
 * as two halves anywhere along the riff, at the same cost, and the bars between land a whole
 * phrase off (measured: a four-bar repeat skipped as two two-bar pieces, the first before
 * the riff even started).
 */
const OPEN = 1.5;
/**
 * Bass the recording plays before the tab starts or after it ends costs more again: a tab
 * covers its song from the first bar, so a recording that plays a phrase twice is likelier
 * than one that plays a phrase before the tab begins (measured: with the two costed alike, a
 * repeated riff was put in front of the tab rather than in the middle, half the time).
 */
const EDGE = 3;
/**
 * Where a riff repeats, the same skip fits in several places at the same cost. Then the later
 * the better: the tab is followed from its start, and what the recording plays twice is
 * taken to be the second time. (Without this the warp took the earliest, and the bars before
 * it went with the copy — for a skip right after the opening rests, the whole tab started a
 * phrase late, the bass playing for seconds before the first bar.) Small enough to settle
 * only near-ties: a twentieth of a unit's mismatch over the whole song.
 */
const LATER = 0.05;
/** Silence against silence: agreement, if uninformative on its own. */
const BOTH_SILENT = 0.85;

interface Unit {
  /** Pitch of the note starting in each slot, -1 for none. */
  onsets: Int16Array;
  /** How much of each pitch class sounds over the unit. */
  chroma: Float64Array;
  energy: number;
}

function emptyUnit(): Unit {
  return { onsets: new Int16Array(SLOTS).fill(-1), chroma: new Float64Array(12), energy: 0 };
}

function addSound(unit: Unit, midi: number, overlap: number): void {
  if (overlap <= 0) return;
  unit.chroma[((midi % 12) + 12) % 12] += overlap;
  unit.energy += overlap;
}

/** Lay notes (start and end in some step, from 0) over units of `perUnit` steps. */
function fillUnits(units: Unit[], notes: Iterable<{ start: number; end: number; midi: number }>, perUnit: number): void {
  for (const { start, end, midi } of notes) {
    const at = Math.floor(start / perUnit);
    if (units[at]) {
      const slot = Math.min(SLOTS - 1, Math.floor(((start - at * perUnit) * SLOTS) / perUnit));
      if (units[at].onsets[slot] < 0) units[at].onsets[slot] = midi;
    }
    for (let u = Math.max(0, at); u < units.length && u * perUnit < end; u++) {
      const overlap = Math.min(end, (u + 1) * perUnit) - Math.max(start, u * perUnit);
      addSound(units[u], midi, overlap / perUnit);
    }
  }
}

interface TabLine {
  /** A unit per quarter note. */
  units: Unit[];
  /** 1 at units where a bar starts (and one past the end). */
  barStart: Uint8Array;
  /** Units of the first and last sounding notes. */
  firstNote: number;
  lastNote: number;
}

function tabLine(bars: ScoreBar[]): TabLine {
  const end = bars.reduce((m, b) => Math.max(m, b.tick + b.ticks), 0);
  const units = Array.from({ length: Math.ceil(end / QUARTER) }, emptyUnit);
  fillUnits(
    units,
    bars.flatMap((bar) => bar.notes.map((n) => ({ start: bar.tick + n.at, end: bar.tick + n.at + n.length, midi: n.midi }))),
    QUARTER,
  );
  const barStart = new Uint8Array(units.length + 1);
  for (const bar of bars) barStart[Math.min(units.length, Math.floor(bar.tick / QUARTER))] = 1;
  barStart[units.length] = 1;
  const firstNote = units.findIndex((u) => u.energy > 0);
  let lastNote = units.length - 1;
  while (lastNote > 0 && units[lastNote].energy === 0) lastNote--;
  return { units, barStart, firstNote, lastNote };
}

interface Grid {
  units: Unit[];
  /** Start time (s) of each unit, and the end of the last. */
  times: number[];
  /** Beats of the recording per unit. */
  beatsPerUnit: number;
}

/** The recording, in units of `slotsPerUnit` analysis slots from slot `offset` on. */
function recordingGrid(analysis: TabAnalysis, slotsPerUnit: number, offset: number): Grid {
  const perBeat = analysis.subdivision;
  const beats = analysis.beats;
  const beatsPerUnit = slotsPerUnit / perBeat;
  if (beats.length < 2) return { units: [], times: [], beatsPerUnit };
  const slotTime = (slot: number) => {
    const b = Math.max(0, Math.min(beats.length - 2, Math.floor(slot / perBeat)));
    return beats[b] + ((slot - b * perBeat) / perBeat) * (beats[b + 1] - beats[b]);
  };
  const count = Math.max(0, Math.floor((beats.length * perBeat - offset) / slotsPerUnit));
  const units = Array.from({ length: count }, emptyUnit);
  fillUnits(
    units,
    analysis.notes.map((n) => ({ start: n.startSlot - offset, end: n.endSlot - offset, midi: n.midi })),
    slotsPerUnit,
  );
  const times = Array.from({ length: count + 1 }, (_, u) => slotTime(offset + u * slotsPerUnit));
  return { units, times, beatsPerUnit };
}

const struck = (u: Unit) => u.onsets.some((p) => p >= 0);

/** 0..1: same pitches sounding, and notes starting in the same places. */
function similarity(a: Unit, b: Unit): number {
  if (a.energy === 0 && b.energy === 0) return BOTH_SILENT;
  if (a.energy === 0 || b.energy === 0) {
    // A note struck where the other side rests is a real disagreement. A note only ringing
    // on is not: how long a note is held is where tabs and players differ most (measured: a
    // waltz written "quarter, rest" whose quarters ring into the rest).
    return struck(a) || struck(b) ? 0 : 0.5;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < 12; k++) {
    dot += a.chroma[k] * b.chroma[k];
    na += a.chroma[k] * a.chroma[k];
    nb += b.chroma[k] * b.chroma[k];
  }
  const tone = dot / Math.sqrt(na * nb);
  let agree = 0;
  let count = 0;
  for (let s = 0; s < SLOTS; s++) {
    const p = a.onsets[s];
    const q = b.onsets[s];
    if (p < 0 && q < 0) continue;
    count++;
    if (p >= 0 && q >= 0) agree += p === q ? 1 : (p - q) % 12 === 0 ? 0.8 : 0.3;
  }
  const rhythm = count ? agree / count : 1;
  return 0.6 * tone + 0.4 * rhythm;
}

interface Warp {
  /** For each tab unit, the recording unit it fell on (fractional where the tab skipped). */
  unitOf: Float64Array;
  /** Similarity of each tab unit to its recording unit (0 where skipped). */
  scoreOf: Float64Array;
  /** Mean of scoreOf: how much of the tab found its match, and how well. */
  quality: number;
  /** Quality less what the skips inside the tab cost, per tab unit: what grids are judged by. */
  fit: number;
}

/**
 * The warp. Skips happen at bar lines of the tab, and the tab skips whole bars: bars are what
 * recordings repeat or leave out, and a skip free to fall inside a bar shortens itself by
 * squeezing the notes around it (measured: a waltz's last dotted half note squeezed onto
 * the beat after a four-bar skip, and its bar line put a phrase early).
 */
function warp(line: TabLine, rec: Unit[]): Warp | null {
  const { units: tab, barStart, firstNote, lastNote } = line;
  const n = tab.length;
  const m = rec.length;
  if (!n || !m) return null;
  const cost = new Float32Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) cost[i * m + j] = 1 - similarity(tab[i], rec[j]);
  const total = new Float64Array(n * m).fill(Infinity);
  // How each cell was reached: 0 from (i-1, j-1); +k from (i-1, j-1-k), k units of the
  // recording skipped; -k from (i-1-k, j-1), k units of the tab skipped.
  const step = new Int8Array(n * m);
  let firstStruck = 0;
  while (firstStruck < m - 1 && !struck(rec[firstStruck])) firstStruck++;
  let lastStruck = m - 1;
  while (lastStruck > 0 && !struck(rec[lastStruck])) lastStruck--;
  // The bass the recording plays before the tab starts is skipped like any other stretch
  // (the silence before it is free: a lead-in, a count-in, an intro without bass).
  for (let j = 0; j < m; j++) total[j] = cost[j] + (j > firstStruck ? EDGE + SKIP * (j - firstStruck) : 0);
  for (let i = 1; i < n; i++) {
    const atBar = barStart[i] === 1;
    for (let j = 1; j < m; j++) {
      let best = total[(i - 1) * m + j - 1];
      let from = 0;
      if (atBar) {
        const later = (LATER * j) / m;
        // Recording skipped between the tab's opening rests and its first note, or between its
        // last note and its closing rests, is bass played before or after the tab.
        const open = (i <= firstNote || i > lastNote ? EDGE : OPEN) - later;
        for (let k = 1; k <= JUMP && j - 1 - k >= 0; k++) {
          const c = total[(i - 1) * m + j - 1 - k] + open + SKIP * k;
          if (c < best) {
            best = c;
            from = k;
          }
        }
        for (let k = 1; k <= JUMP && i - 1 - k >= 0; k++) {
          if (!barStart[i - k]) continue;
          const c = total[(i - 1 - k) * m + j - 1] + OPEN - later + SKIP * k;
          if (c < best) {
            best = c;
            from = -k;
          }
        }
      }
      total[i * m + j] = best + cost[i * m + j];
      step[i * m + j] = from;
    }
  }
  // ...and so is what it plays after the tab ends (the last note ringing out is free).
  const endCost = (k: number) => total[(n - 1) * m + k] + (k < lastStruck ? EDGE + SKIP * (lastStruck - k) : 0);
  let j = 0;
  for (let k = 1; k < m; k++) if (endCost(k) < endCost(j)) j = k;
  if (!Number.isFinite(endCost(j))) return null;

  const unitOf = new Float64Array(n).fill(NaN);
  const scoreOf = new Float64Array(n);
  let skipped = 0;
  let i = n - 1;
  for (;;) {
    unitOf[i] = j;
    scoreOf[i] = 1 - cost[i * m + j];
    if (i === 0) break;
    const from = step[i * m + j];
    if (from !== 0) skipped += (from > 0 && (i <= firstNote || i > lastNote) ? EDGE : OPEN) + SKIP * Math.abs(from);
    if (from >= 0) {
      i -= 1;
      j -= 1 + from;
    } else {
      // Tab units the recording does not play: they have no time of their own, and sit at
      // the join (marked skipped by a score of 0).
      for (let k = 1; k <= -from; k++) unitOf[i - k] = j - 0.5;
      i -= 1 - from;
      j -= 1;
    }
  }
  const quality = scoreOf.reduce((a, b) => a + b, 0) / n;
  return { unitOf, scoreOf, quality, fit: quality - skipped / n };
}

/** Time (s) at a fractional unit of a grid, extrapolating past either end at the nearest gap. */
function gridTime(times: number[], at: number): number {
  const last = times.length - 1;
  if (last < 1) return times[0] ?? 0;
  const i = Math.max(0, Math.min(last - 1, Math.floor(at)));
  return times[i] + (at - i) * (times[i + 1] - times[i]);
}

/**
 * Where each bar of the tab starts in the recording, or null when there is nothing to line up
 * (a tab without notes, a recording without beats).
 */
export function alignScore(bars: ScoreBar[], analysis: TabAnalysis): AlignResult | null {
  const line = tabLine(bars);
  const { units: tab, firstNote, lastNote } = line;
  if (firstNote < 0) return null;

  let best: { warp: Warp; grid: Grid } | null = null;
  for (const [slotsPerUnit, offset] of GRIDS) {
    // A quarter note faster than 320 or slower than 30 is no reading of a tab.
    const quarterBpm = (analysis.bpm * analysis.subdivision) / slotsPerUnit;
    if (quarterBpm > 320 || quarterBpm < 30) continue;
    const grid = recordingGrid(analysis, slotsPerUnit, offset);
    const result = warp(line, grid.units);
    if (result && (!best || result.fit > best.warp.fit)) best = { warp: result, grid };
  }
  if (!best) return null;
  const { warp: w, grid } = best;

  // Before the tab's first note and after its last, nothing pins the warp — the rests could
  // sit a beat either way, and a stray sound in a rest (bleed, a count-in) pulls them there
  // (measured: an intro bar a beat late). Those bars are counted out on the grid from the
  // first and last notes instead, the way a player counts rests.
  for (let u = 0; u < firstNote; u++) w.unitOf[u] = w.unitOf[firstNote] - (firstNote - u);
  for (let u = lastNote + 1; u < tab.length; u++) w.unitOf[u] = w.unitOf[lastNote] + (u - lastNote);

  // The tab position (in quarter notes) of every bar line, to recording time, through the warp.
  const positionTime = (quarters: number) => {
    const i = Math.max(0, Math.min(w.unitOf.length - 1, Math.floor(quarters)));
    const frac = quarters - i;
    const here = w.unitOf[i];
    const next = i + 1 < w.unitOf.length ? w.unitOf[i + 1] : here + 1;
    return gridTime(grid.times, here + frac * (next - here));
  };
  const out: AlignedBar[] = bars.map((bar) => {
    const first = Math.floor(bar.tick / QUARTER);
    const end = (bar.tick + bar.ticks) / QUARTER;
    const last = Math.max(first, Math.ceil(end) - 1);
    let sum = 0;
    for (let u = first; u <= last && u < w.scoreOf.length; u++) sum += w.scoreOf[u];
    // The end from inside the bar: through the bar's own last unit, not the next bar's first
    // (which, after a skip, is somewhere else in the recording).
    const lastUnit = Math.min(last, w.unitOf.length - 1);
    return {
      barIndex: bar.index,
      tick: bar.tick,
      audioMs: Math.round(positionTime(bar.tick / QUARTER) * 1000),
      endMs: Math.round(gridTime(grid.times, w.unitOf[lastUnit] + (end - lastUnit)) * 1000),
      agreement: sum / Math.max(1, last - first + 1),
    };
  });
  return { bars: out, beatsPerQuarter: grid.beatsPerUnit, agreement: w.quality };
}

/** A point tying the tab to the recording: synth tick (repeats played out) to recording time. */
export interface AlignedAnchor {
  tick: number;
  audioMs: number;
  barIndex: number;
  /** 0 the first time through the bar, 1 on the repeat, ... */
  occurrence: number;
}

/**
 * The alignment as sync anchors: every bar line, and where the recording plays something the
 * tab does not, the end of the bar before it as well — one tick before the next bar line — so
 * that playback jumps the extra stretch at the bar line instead of slowing the whole bar down
 * to cover it.
 */
export function alignedAnchors(result: AlignResult): AlignedAnchor[] {
  const out: AlignedAnchor[] = [];
  const seen = new Map<number, number>();
  result.bars.forEach((bar, i) => {
    const occurrence = seen.get(bar.barIndex) ?? 0;
    seen.set(bar.barIndex, occurrence + 1);
    out.push({ tick: bar.tick, audioMs: bar.audioMs, barIndex: bar.barIndex, occurrence });
    const next = result.bars[i + 1];
    // A gap of more than rounding's slack is a skip: at least a unit, 190ms even at 320 BPM.
    if (next && next.tick > bar.tick + 1 && next.audioMs - bar.endMs > 60) {
      out.push({ tick: next.tick - 1, audioMs: bar.endMs, barIndex: bar.barIndex, occurrence });
    }
  });
  return out;
}
