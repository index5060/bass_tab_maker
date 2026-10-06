/**
 * Core data types.
 *
 * Design note on sync points
 * --------------------------
 * alphaTab persists sync data as `FlatSyncPoint` = { barIndex, barPosition, barOccurence,
 * millisecondOffset }. That is bar-relative, which is great for interop but awkward to
 * *capture* live, because with repeats/jumps the MIDI timeline plays the same bar several
 * times and you would have to resolve which occurrence you just heard.
 *
 * So we store a superset: the raw synth tick (which is what we actually measured, repeats
 * already expanded by alphaTab's MIDI generator) plus the bar info purely for display and
 * for a future export to FlatSyncPoint. The mapping code only ever reads `synthTick`.
 */

export interface SyncAnchor {
  /** alphaTab MIDI tick at the moment the anchor was captured (repeats expanded). */
  synthTick: number;
  /** Matching position inside the original audio file, in milliseconds. */
  audioMs: number;
  /** Display only: which bar this landed in (0-based), if known. */
  barIndex?: number;
  /** Display only: 0 on the first pass through the bar, 1 on the repeat, ... */
  barOccurence?: number;
}

/**
 * What you are currently listening to. 'synth' is alphaTab's MIDI playback; the rest are
 * recorded sources living in the AudioDeck. Stem sources only become selectable once a
 * separation has been run.
 */
export type PlaybackSource = 'synth' | 'original' | 'bass' | 'minusBass';

export interface LoopSection {
  id: string;
  name: string;
  startTick: number;
  endTick: number;
  /** Speed to start this loop at (1 = 100%). Used by the auto speed-ramp. */
  startSpeed: number;
  /** Speed to work up to. */
  targetSpeed: number;
}

export interface Bookmark {
  id: string;
  tick: number;
  barIndex: number;
  note: string;
}

export type ScoreKind = 'gp' | 'alphatex';

import type { StemSet } from './stems';
export type { StemSet };

/**
 * One practiced song. The score itself is kept untouched (the original .gp bytes or the
 * alphaTex source); everything we add for practice lives beside it in this same record.
 */
export interface PracticeDoc {
  id: string;
  title: string;
  artist: string;

  scoreKind: ScoreKind;
  /** Raw .gp/.gp5/.gpx bytes, or alphaTex source text. */
  scoreData: ArrayBuffer | string;
  scoreFileName?: string;

  /** The original recording, if one has been attached. */
  audioBlob?: Blob;
  audioFileName?: string;

  /**
   * Separated stems, once they exist. Kept beside the original rather than replacing it —
   * separation is lossy in the sense that you can never get the original back exactly, and
   * re-running it is expensive.
   */
  stems?: StemSet;

  syncAnchors: SyncAnchor[];
  loops: LoopSection[];
  bookmarks: Bookmark[];

  lastSpeed: number;
  lastSource: PlaybackSource;
  /** Index of the track alphaTab should display (usually the bass track). */
  trackIndex: number;

  createdAt: number;
  updatedAt: number;
}

export function newPracticeDoc(partial: Partial<PracticeDoc> = {}): PracticeDoc {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'Untitled',
    artist: '',
    scoreKind: 'alphatex',
    scoreData: '',
    syncAnchors: [],
    loops: [],
    bookmarks: [],
    lastSpeed: 1,
    lastSource: 'synth',
    trackIndex: 0,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}
