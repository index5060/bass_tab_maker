/**
 * Sync mapping: alphaTab synth tick  <->  original audio milliseconds.
 *
 * This is the whole of "B-2" as a data structure. A piecewise-linear map defined by N
 * anchors. Two anchors give you the simple "offset + fixed tempo ratio" behaviour ("B-1");
 * adding more anchors is what lets you track a drifting live recording. No code changes
 * between the two — only how many anchors exist.
 *
 * Why tick space and not time space: when playback speed changes, the synth's tick position
 * and the audio element's media time both slow down by the same factor, so a tick -> media-ms
 * map is speed-independent. A time -> time map would not be.
 *
 * Kept free of any alphaTab imports so it can be unit tested on its own.
 */

import type { SyncAnchor } from './types';

/** Anchors sorted by tick, with duplicate/non-monotonic entries dropped. */
export type NormalizedAnchors = readonly SyncAnchor[];

export function normalizeAnchors(anchors: readonly SyncAnchor[]): NormalizedAnchors {
  const sorted = [...anchors]
    .filter((a) => Number.isFinite(a.synthTick) && Number.isFinite(a.audioMs))
    .sort((a, b) => a.synthTick - b.synthTick);

  const out: SyncAnchor[] = [];
  for (const a of sorted) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(a);
      continue;
    }
    // Same tick -> the newer anchor wins (user re-tapped the same spot).
    if (a.synthTick === prev.synthTick) {
      out[out.length - 1] = a;
      continue;
    }
    // Audio time must advance with tick, otherwise the segment would play backwards.
    if (a.audioMs <= prev.audioMs) continue;
    out.push(a);
  }
  return out;
}

export function isUsable(anchors: NormalizedAnchors): boolean {
  return anchors.length >= 2;
}

interface Segment {
  fromTick: number;
  toTick: number;
  slope: number; // ms of audio per tick
  intercept: number;
}

function segmentAt(anchors: NormalizedAnchors, tick: number): Segment | null {
  if (anchors.length < 2) return null;

  // Pick the bracketing pair; clamp to the first/last pair so we extrapolate with the
  // nearest known tempo rather than falling off a cliff before bar 1 / after the last anchor.
  let i = 0;
  if (tick >= anchors[anchors.length - 1].synthTick) {
    i = anchors.length - 2;
  } else {
    // binary search for the last anchor whose tick is <= tick
    let lo = 0;
    let hi = anchors.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (anchors[mid].synthTick <= tick) lo = mid;
      else hi = mid - 1;
    }
    i = Math.min(lo, anchors.length - 2);
  }

  const a = anchors[i];
  const b = anchors[i + 1];
  const dTick = b.synthTick - a.synthTick;
  if (dTick <= 0) return null;
  const slope = (b.audioMs - a.audioMs) / dTick;
  return { fromTick: a.synthTick, toTick: b.synthTick, slope, intercept: a.audioMs };
}

/** Where in the original recording does this synth tick land? null if not enough anchors. */
export function tickToAudioMs(anchors: NormalizedAnchors, tick: number): number | null {
  const seg = segmentAt(anchors, tick);
  if (!seg) return null;
  return seg.intercept + (tick - seg.fromTick) * seg.slope;
}

/** Inverse map, for "I found the spot in the audio, jump the tab there". */
export function audioMsToTick(anchors: NormalizedAnchors, ms: number): number | null {
  if (anchors.length < 2) return null;

  let i = 0;
  if (ms >= anchors[anchors.length - 1].audioMs) {
    i = anchors.length - 2;
  } else {
    let lo = 0;
    let hi = anchors.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (anchors[mid].audioMs <= ms) lo = mid;
      else hi = mid - 1;
    }
    i = Math.min(lo, anchors.length - 2);
  }

  const a = anchors[i];
  const b = anchors[i + 1];
  const dMs = b.audioMs - a.audioMs;
  if (dMs <= 0) return null;
  const slope = (b.synthTick - a.synthTick) / dMs;
  return a.synthTick + (ms - a.audioMs) * slope;
}

/**
 * How fast the recording runs compared to the tempo written in the score, for the segment
 * containing `tick`. 1.0 = the score's tempo is right; 1.02 = the recording is 2% faster.
 * Purely informational, but it is the number that tells you whether a single pair of anchors
 * is going to hold up or whether you need more.
 */
export function tempoRatioAt(
  anchors: NormalizedAnchors,
  tick: number,
  ticksPerQuarter: number,
  scoreBpm: number,
): number | null {
  const seg = segmentAt(anchors, tick);
  if (!seg || seg.slope <= 0) return null;
  const scoreMsPerTick = 60000 / scoreBpm / ticksPerQuarter;
  return scoreMsPerTick / seg.slope;
}

/**
 * Predicted drift, in milliseconds, at `tick` if you kept only the first two anchors and
 * threw the rest away. This is the "do I actually need more anchors?" readout — if it stays
 * under ~30ms across the song, two anchors is genuinely enough for this recording.
 */
export function driftIfLinear(anchors: NormalizedAnchors, tick: number): number | null {
  if (anchors.length < 3) return null;
  const twoPoint = normalizeAnchors([anchors[0], anchors[anchors.length - 1]]);
  const full = tickToAudioMs(anchors, tick);
  const approx = tickToAudioMs(twoPoint, tick);
  if (full === null || approx === null) return null;
  return approx - full;
}
