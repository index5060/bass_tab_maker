import { describe, expect, it } from 'vitest';
import { alignedAnchors, alignScore } from './align';
import type { TabAnalysis } from './index';
import type { GridNote } from './notes';
import type { ScoreBar, ScoreNote } from './scoreLine';

/**
 * The aligner on made-up data: a tab, and a "recording" given as what analyseTab would have
 * heard in it — beats, and notes on their sixteenth grid. (The real thing, from rendered
 * audio, is eval/sync.eval.ts.)
 */

const Q = 960;

/** Eight bars of four, every bar its own: quarters and eighths, no two bars alike. */
function line(bars = 8): ScoreNote[][] {
  const out: ScoreNote[][] = [];
  let seed = 7;
  const next = () => (seed = (seed * 37 + 11) % 101);
  for (let b = 0; b < bars; b++) {
    const notes: ScoreNote[] = [];
    for (let q = 0; q < 4; q++) {
      const midi = 28 + (next() % 17);
      if (next() % 3 === 0) {
        notes.push({ at: q * Q, length: Q / 2, midi }, { at: q * Q + Q / 2, length: Q / 2, midi: 28 + (next() % 17) });
      } else {
        notes.push({ at: q * Q, length: Q, midi });
      }
    }
    out.push(notes);
  }
  return out;
}

function tab(bars: ScoreNote[][]): ScoreBar[] {
  return bars.map((notes, index) => ({ index, tick: index * 4 * Q, ticks: 4 * Q, notes }));
}

/**
 * What would be heard playing `bars` one after another from beat `startBeat` of a beat grid
 * every `period` seconds, a tab quarter note lasting `beatsPerQuarter` beats.
 */
function heard(bars: ScoreNote[][], options: { startBeat?: number; period?: number; beatsPerQuarter?: number; tailBeats?: number } = {}): TabAnalysis {
  const { startBeat = 3, period = 0.5, beatsPerQuarter = 1, tailBeats = 4 } = options;
  const slotsPerTick = (4 * beatsPerQuarter) / Q;
  const notes: GridNote[] = [];
  bars.forEach((barNotes, b) => {
    for (const n of barNotes) {
      const at = startBeat * 4 + (b * 4 * Q + n.at) * slotsPerTick;
      notes.push({ startSlot: Math.round(at), endSlot: Math.round(at + n.length * slotsPerTick), midi: n.midi, confidence: 0.9 });
    }
  });
  const beatCount = Math.ceil(startBeat + bars.length * 4 * beatsPerQuarter + tailBeats);
  const beats = Array.from({ length: beatCount }, (_, k) => 0.25 + k * period);
  return {
    beats,
    firstTracked: 0,
    lastTracked: beatCount - 1,
    bpm: 60 / period,
    notes,
    subdivision: 4,
    meter: { beatsPerBar: 4, downbeatPhase: 0, confidence: 1, candidates: [] },
    tuningCents: 0,
    beatSource: 'band',
    tempos: [],
    durationSeconds: beats[beatCount - 1] + period,
  };
}

/** Recording time (ms) of beat `beat` (fractional) on the grid heard() lays out. */
const beatMs = (beat: number, period = 0.5) => Math.round((0.25 + beat * period) * 1000);

describe('lining a tab up with a recording', () => {
  it('finds every bar line', () => {
    const music = line();
    const result = alignScore(tab(music), heard(music))!;
    expect(result.beatsPerQuarter).toBe(1);
    expect(result.agreement).toBeGreaterThan(0.95);
    result.bars.forEach((bar, k) => expect(Math.abs(bar.audioMs - beatMs(3 + 4 * k))).toBeLessThanOrEqual(1));
  });

  it('counts out opening rest bars from the first note, however long the silence before it', () => {
    const music = [[], [], ...line(6)];
    const result = alignScore(tab(music), heard(music.slice(2), { startBeat: 17 }))!;
    // Bar 3 (the first with notes) is where the music starts; bars 1 and 2 are counted back.
    expect(result.bars.map((b) => b.audioMs)).toEqual([beatMs(9), beatMs(13), beatMs(17), ...[1, 2, 3, 4, 5].map((k) => beatMs(17 + 4 * k))]);
  });

  it('skips bars the recording plays twice — the second time — and jumps them at the bar line', () => {
    const music = line();
    // The recording plays bars 3 and 4 twice.
    const played = [...music.slice(0, 4), music[2], music[3], ...music.slice(4)];
    const result = alignScore(tab(music), heard(played))!;
    const expected = [0, 1, 2, 3, 6, 7, 8, 9].map((k) => beatMs(3 + 4 * k));
    result.bars.forEach((bar, k) => expect(Math.abs(bar.audioMs - expected[k])).toBeLessThanOrEqual(1));

    // Playback runs bar 4 at its own pace, then jumps the copy: an anchor at its end.
    const anchors = alignedAnchors(result);
    const jump = anchors.find((a) => a.tick === 4 * 4 * Q - 1);
    expect(jump).toBeDefined();
    expect(Math.abs(jump!.audioMs - beatMs(3 + 16))).toBeLessThanOrEqual(1);
    expect(anchors.filter((a) => a.tick % (4 * Q) === 0)).toHaveLength(8);
  });

  it('skips a phrase of a riff in one go, even with the pickup into the riff not heard', () => {
    const [x, y, z] = line(3);
    const pickup: ScoreNote[] = [{ at: 3 * Q, length: Q, midi: 40 }];
    const music = [[], pickup, x, y, x, y, x, y, z];
    // The recording plays the riff four bars longer, and the pickup was not picked up.
    const played = [[], [], x, y, x, y, x, y, x, y, x, y, z];
    const result = alignScore(tab(music), heard(played))!;
    const skips = alignedAnchors(result).filter((a) => a.tick % (4 * Q) !== 0);
    expect(skips).toHaveLength(1);
    // Every bar of the riff lands on a bar playing the same thing; z on z.
    const barAt = (ms: number) => Math.round((ms - beatMs(3)) / (4 * 500));
    result.bars.forEach((bar, k) => {
      if (k >= 2) expect(played[barAt(bar.audioMs)]).toBe(music[k]);
    });
    // Bar 1 (the pickup) right before the first x, not a phrase late.
    expect(barAt(result.bars[1].audioMs)).toBe(1);
  });

  it('passes over bars of the tab the recording leaves out', () => {
    const music = line();
    const played = [...music.slice(0, 3), ...music.slice(5)];
    const result = alignScore(tab(music), heard(played))!;
    const at = (k: number) => result.bars[k].audioMs;
    for (const k of [0, 1, 2]) expect(Math.abs(at(k) - beatMs(3 + 4 * k))).toBeLessThanOrEqual(1);
    for (const k of [5, 6, 7]) expect(Math.abs(at(k) - beatMs(3 + 4 * (k - 2)))).toBeLessThanOrEqual(1);
    // The two left out sit at the join, in order.
    expect(at(3)).toBeLessThanOrEqual(at(4));
    expect(at(4)).toBeLessThanOrEqual(at(5));
  });

  it('reads a recording whose beats were tracked at half the tempo', () => {
    const music = line();
    const result = alignScore(tab(music), heard(music, { period: 1, beatsPerQuarter: 0.5 }))!;
    expect(result.beatsPerQuarter).toBe(0.5);
    result.bars.forEach((bar, k) => expect(Math.abs(bar.audioMs - beatMs(3 + 2 * k, 1))).toBeLessThanOrEqual(1));
  });

  it('reads a recording whose beats were tracked at double the tempo, starting on either beat', () => {
    const music = line();
    for (const startBeat of [3, 4]) {
      const result = alignScore(tab(music), heard(music, { period: 0.25, beatsPerQuarter: 2, startBeat }))!;
      expect(result.beatsPerQuarter).toBe(2);
      result.bars.forEach((bar, k) => expect(Math.abs(bar.audioMs - beatMs(startBeat + 8 * k, 0.25))).toBeLessThanOrEqual(1));
    }
  });

  it('says so when the recording is not of this tab', () => {
    const other = line(12).slice(4);
    const result = alignScore(tab(line()), heard(other.map((bar) => bar.map((n) => ({ ...n, midi: n.midi + 5 })))));
    expect(result?.agreement ?? 0).toBeLessThan(0.5);
  });

  it('has nothing to line up without notes or without beats', () => {
    expect(alignScore(tab([[], []]), heard(line()))).toBeNull();
    expect(alignScore(tab(line()), { ...heard(line()), beats: [] })).toBeNull();
  });

  it('numbers the passes through a repeated bar', () => {
    const music = line(2);
    const bars: ScoreBar[] = [0, 1, 0, 1].map((index, k) => ({ index, tick: k * 4 * Q, ticks: 4 * Q, notes: music[index] }));
    const anchors = alignedAnchors(alignScore(bars, heard([...music, ...music]))!);
    expect(anchors.map((a) => [a.barIndex, a.occurrence])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
  });
});
