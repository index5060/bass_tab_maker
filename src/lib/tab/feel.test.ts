import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import { chooseDivisions } from './feel';
import { writeTab } from './write';
import { writeTabFrom, type TabAnalysis } from './index';
import { BASS_TUNING } from './frets';

/** Beats at `bpm` from 1s, and attacks at the given fractions of each listed beat. */
function song(bpm: number, beats: number, places: (beat: number) => number[], late = 0) {
  const period = 60 / bpm;
  const times = Array.from({ length: beats }, (_, k) => 1 + k * period);
  const attacks = times.flatMap((t, k) => places(k).map((p) => ({ time: t + p * period + late, strength: 1 })));
  return { times, attacks };
}

describe('straight or triplet, beat by beat', () => {
  it('keeps straight eighths and sixteenths in four', () => {
    const { times, attacks } = song(120, 32, (k) => (k % 2 ? [0, 0.25, 0.5, 0.75] : [0, 0.5]));
    expect(chooseDivisions(times, attacks).every((d) => d === 4)).toBe(true);
  });

  it('reads a shuffle in three', () => {
    const { times, attacks } = song(90, 32, () => [0, 2 / 3]);
    expect(chooseDivisions(times, attacks).every((d) => d === 3)).toBe(true);
  });

  it('reads a triplet fill in a straight song, and only there', () => {
    const { times, attacks } = song(100, 32, (k) => (k >= 12 && k < 16 ? [0, 1 / 3, 2 / 3] : [0, 0.5]));
    const divisions = chooseDivisions(times, attacks);
    expect(divisions.slice(12, 16)).toEqual([3, 3, 3, 3]);
    expect(divisions.filter((d, k) => d === 3 && (k < 12 || k >= 16))).toEqual([]);
  });

  it('allows for attacks that all come late', () => {
    // At 80 BPM two thirds and three quarters of a beat are 62ms apart; 40ms late, a triplet
    // reads nearer the straight place unless the lateness is taken out first.
    const { times, attacks } = song(80, 32, () => [0, 1 / 3, 2 / 3], 0.04);
    expect(chooseDivisions(times, attacks).every((d) => d === 3)).toBe(true);
  });

  it('keeps beats without evidence in the feel around them', () => {
    const { times, attacks } = song(90, 24, (k) => (k % 4 === 2 ? [0] : [0, 1 / 3, 2 / 3]));
    expect(chooseDivisions(times, attacks).every((d) => d === 3)).toBe(true);
  });
});

describe('writing triplets', () => {
  const beats = Array.from({ length: 9 }, (_, k) => 1 + k * 0.5);
  const note = (startSlot: number, endSlot: number, fret: number, string: number) => ({
    startSlot,
    endSlot,
    midi: BASS_TUNING[4 - string] + fret,
    confidence: 1,
    fret,
    string,
  });

  it('writes a beat in three as triplets, tied across into a beat in four', () => {
    // On a grid of 12 per beat: beat 1 in three — notes on its thirds — and the last third
    // held into beat 2, which is in four.
    const result = writeTab({
      title: 'Triplets',
      notes: [note(0, 12, 0, 3), note(12, 16, 2, 3), note(16, 20, 3, 3), note(20, 27, 5, 3), note(27, 48, 0, 3)],
      beats,
      beatsPerBar: 4,
      subdivision: 12,
      divisions: [4, 3, 4, 4, 4, 4, 4, 4, 4],
      trackedBeats: { first: 0, last: 8 },
    });
    const bar = result.alphaTex.split('\n').find((l) => l.endsWith('|'))!;
    expect(bar).toBe('\\ts (4 4) :4 0.3 :8 2.3{tu 3} 3.3{tu 3} 5.3{tu 3} :16 -.3 :4 0.3{d} :16 -.3 |');
  });

  it('comes out of alphaTab with every bar the right length', () => {
    const result = writeTab({
      title: 'Triplets',
      notes: [note(0, 8, 0, 3), note(8, 12, 2, 3), note(12, 20, 3, 3), note(20, 24, 5, 3), note(36, 40, 7, 3), note(40, 48, 5, 3)],
      beats,
      beatsPerBar: 4,
      subdivision: 12,
      divisions: [3, 3, 4, 3, 4, 4, 4, 4, 4],
      trackedBeats: { first: 0, last: 8 },
    });
    const score = alphaTab.importer.ScoreLoader.loadAlphaTex(result.alphaTex);
    const bar = score.tracks[0].staves[0].bars[0];
    const played = bar.voices[0].beats.reduce((sum, b) => sum + b.playbackDuration, 0);
    expect(played).toBe(4 * 960);
    // The triplet quarter and triplet eighth of beat 1 start where a third of a beat says.
    const starts = bar.voices[0].beats.filter((b) => !b.isRest).map((b) => b.playbackStart);
    expect(starts.slice(0, 4)).toEqual([0, 640, 960, 1600]);
  });
});

describe('analyses saved before triplets were read', () => {
  it('are written as before: a grid of four, every beat straight', () => {
    const beats = Array.from({ length: 17 }, (_, k) => 0.5 + k * 0.5);
    const now: TabAnalysis = {
      beats,
      firstTracked: 0,
      lastTracked: 16,
      bpm: 120,
      notes: [
        { startSlot: 0, endSlot: 6, midi: 33, confidence: 1 },
        { startSlot: 6, endSlot: 12, midi: 36, confidence: 1 },
        { startSlot: 12, endSlot: 21, midi: 38, confidence: 1 },
        { startSlot: 21, endSlot: 48, midi: 40, confidence: 1 },
      ],
      subdivision: 12,
      divisions: beats.map(() => 4),
      meter: { beatsPerBar: 4, downbeatPhase: 0, confidence: 1, candidates: [] },
      tuningCents: 0,
      beatSource: 'band',
      tempos: [],
      durationSeconds: 9,
    };
    const saved: TabAnalysis = {
      ...now,
      subdivision: 4,
      divisions: undefined,
      notes: now.notes.map((n) => ({ ...n, startSlot: n.startSlot / 3, endSlot: n.endSlot / 3 })),
    };
    const a = writeTabFrom(now, { title: 'T' });
    const b = writeTabFrom(saved, { title: 'T' });
    expect(b.alphaTex).toBe(a.alphaTex);
    expect(b.anchors).toEqual(a.anchors);
    expect(a.alphaTex).toContain('\\ts (4 4) :8 0.3 3.3 0.2{d} :2 2.2 :16 -.2 |');
  });
});
