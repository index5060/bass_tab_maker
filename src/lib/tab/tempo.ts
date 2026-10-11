/**
 * Which tempo the beats are at.
 *
 * The autocorrelation (beats.ts) finds the periods the music repeats at; which of them is the
 * beat — 96 BPM or 192, 66 or 132 — it can only guess. On the test songs its first and second
 * choices were often within a few percent of each other, and twice the wrong octave won: a
 * funk groove with sixteenth hi-hats read at double tempo, a waltz at half. So the octaves of
 * its best guess are each tracked through the song and judged by what makes a beat a beat:
 *
 *   - the drums fit a bar on it: snare on 2 and 4, kick on 1 and 3 (or a waltz's 1-2-3). At
 *     double tempo that pattern falls apart, and at half tempo the snare goes missing.
 *   - it stands out from its own off-beats. Off-beats as strong as the beats mean the grid
 *     is a level off: either they are beats too (a waltz at one beat per two), or the "beats"
 *     are themselves subdivisions of a busy pattern (sixteenth hats read as eighth beats).
 */

import { tempoCandidates, trackBeats, type BeatTrack, type OnsetStrength, type TempoEstimate } from './beats';
import { drumHits, drumPattern, peakNear } from './meter';

export interface BeatChoice extends BeatTrack {
  tempo: TempoEstimate;
  /** The tempo octaves considered and how each scored, for diagnosis. */
  considered: Array<{ bpm: number; autocorrelation: number; drums: number; offbeats: number; total: number }>;
}

const MIN_BPM = 50;
const MAX_BPM = 220;
/** Off-beats at this fraction of the beats' strength or more: the grid is a metrical level off. */
const EVEN_OFFBEATS = 0.85;

const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);

/**
 * How well the drums fit a bar pattern on these beats: the best reading in each stretch of
 * 16 beats, averaged. Judged stretch by stretch because a song's bar lines need not stay in
 * one phase from start to end — an edit, a bar of 2, a beat the tracker dropped — and one
 * phase for the whole song would then average the pattern away (measured: a song repeated
 * with a gap in between scored at half tempo, where the drift did not matter).
 */
function drumFit(beats: number[], onset: OnsetStrength, tracked: { first: number; last: number }): number {
  const hits = drumHits(beats, onset);
  const fits: number[] = [];
  for (let from = tracked.first; from + 16 <= tracked.last + 1; from += 8) {
    const use = beats.map((_, i) => i >= from && i < from + 16);
    fits.push(Math.max(...drumPattern(hits, use).map((d) => d.drum)));
  }
  if (!fits.length) {
    const use = beats.map((_, i) => i >= tracked.first && i <= tracked.last);
    fits.push(Math.max(...drumPattern(hits, use).map((d) => d.drum)));
  }
  return Math.max(0, mean(fits));
}

/**
 * Beats for a recording. `drums`: whether `onset` comes from a band with drums (the separated
 * accompaniment, or the full mix) rather than from the bass alone.
 */
export function findBeats(
  onset: OnsetStrength,
  durationSeconds: number,
  options: { bpm?: number; drums: boolean },
): BeatChoice {
  if (options.bpm && options.bpm > 0) {
    // The user knows the tempo: that pins the period, the beats are still tracked.
    const tempo = { bpm: options.bpm, period: 60 / options.bpm / onset.hop };
    return { ...trackBeats(onset, durationSeconds, { tempo }), tempo, considered: [] };
  }

  const candidates = tempoCandidates(onset.envelope, onset.hop, { minBpm: MIN_BPM, maxBpm: MAX_BPM });
  const best = candidates[0];
  const octaves = [best.bpm, best.bpm * 2, best.bpm / 2].filter((bpm) => bpm >= MIN_BPM && bpm <= MAX_BPM);
  const tried = octaves.map((bpm) => {
    // The autocorrelation's own peak near this tempo, where there is one: its period is the
    // more precise, and its score says how much the music repeats there.
    const tempo = candidates.find((c) => Math.abs(Math.log(c.bpm / bpm)) < 0.04) ?? {
      bpm,
      period: 60 / bpm / onset.hop,
      score: 0,
    };
    const track = trackBeats(onset, durationSeconds, { tempo });
    const tracked = { first: track.firstTracked, last: track.lastTracked };
    const beats = track.beats.slice(tracked.first, tracked.last + 1);
    const strength = mean(beats.map((t) => peakNear(onset.envelope, onset.hop, onset.offset, t)));
    const between = mean(beats.slice(1).map((t, i) => peakNear(onset.envelope, onset.hop, onset.offset, (t + beats[i]) / 2)));
    const drums = options.drums ? drumFit(track.beats, onset, tracked) : 0;
    return { tempo, track, autocorrelation: Math.max(0, tempo.score ?? 0), drums, offbeats: strength > 0 ? between / strength : 1 };
  });

  // Each judge's opinion relative to its best, so neither's units matter.
  const topAc = Math.max(...tried.map((t) => t.autocorrelation)) || 1;
  const topDrums = Math.max(...tried.map((t) => t.drums)) || 1;
  const scored = tried.map((t) => {
    let total = t.autocorrelation / topAc + t.drums / topDrums;
    if (t.offbeats >= EVEN_OFFBEATS) total *= 0.5;
    return { ...t, total };
  });
  const chosen = scored.reduce((a, b) => (b.total > a.total ? b : a));
  return {
    ...chosen.track,
    tempo: chosen.tempo,
    considered: scored.map((t) => ({
      bpm: t.tempo.bpm,
      autocorrelation: t.autocorrelation,
      drums: t.drums,
      offbeats: t.offbeats,
      total: t.total,
    })),
  };
}
