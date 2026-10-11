/**
 * An existing tab, synced to the recording automatically: the glue between alphaTab's score
 * model and the aligner (lib/tab/align.ts), which knows nothing of alphaTab.
 *
 * The bars are taken in the order the player plays them — repeats, voltas and jumps played
 * out by the same MIDI generator the player runs — so every anchor's tick is a tick the
 * player will actually pass through.
 */

import * as alphaTab from '@coderline/alphatab';
import type { TabAnalysis } from './tab';
import { alignedAnchors, alignScore, type AlignResult } from './tab/align';
import { pickBassTrack, scoreBars } from './tab/scoreLine';
import type { ScoreKind, SyncAnchor } from './types';

export interface ScoreSync {
  /** One per bar line, plus one where playback has to jump a stretch the tab does not have. */
  anchors: SyncAnchor[];
  result: AlignResult;
  /** The track that was lined up: the bass, when the score has one. */
  trackIndex: number;
  trackName: string;
}

/** Read a score the way the player will. Throws on data alphaTab cannot read. */
export function readScore(kind: ScoreKind, data: ArrayBuffer | string, settings?: alphaTab.Settings): alphaTab.model.Score {
  return kind === 'alphatex' || typeof data === 'string'
    ? alphaTab.importer.ScoreLoader.loadAlphaTex(String(data), settings)
    : alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(data), settings);
}

/** The track a bass player wants to see: the bass, if the score has one. */
export function bassTrackOf(score: alphaTab.model.Score, preferred = 0): number {
  return pickBassTrack(score, preferred);
}

/** Every pass through every bar, at the player's ticks. */
function playedBars(score: alphaTab.model.Score, settings?: alphaTab.Settings) {
  const generator = new alphaTab.midi.MidiFileGenerator(
    score,
    settings ?? new alphaTab.Settings(),
    new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile()),
  );
  generator.generate();
  return generator.tickLookup.masterBars;
}

/** Line the score's bass part up with what was heard in the recording. Null: nothing to line up. */
export function syncScore(
  score: alphaTab.model.Score,
  analysis: TabAnalysis,
  options: { preferredTrack?: number; settings?: alphaTab.Settings } = {},
): ScoreSync | null {
  const trackIndex = pickBassTrack(score, options.preferredTrack ?? 0);
  const bars = scoreBars(score, trackIndex, playedBars(score, options.settings));
  const result = alignScore(bars, analysis);
  if (!result) return null;
  return {
    anchors: alignedAnchors(result).map((a) => ({
      synthTick: a.tick,
      audioMs: a.audioMs,
      barIndex: a.barIndex,
      barOccurence: a.occurrence,
    })),
    result,
    trackIndex,
    trackName: score.tracks[trackIndex]?.name || `Track ${trackIndex + 1}`,
  };
}

/** What the sync panel shows about the last automatic sync. */
export interface AutoSyncSummary {
  /** The song it was run for: a result must not be shown against another song. */
  songId: string;
  /** 0..1 over the whole tab. */
  agreement: number;
  /** Bars (passes through bars) lined up. */
  bars: number;
  beatsPerQuarter: number;
  trackName: string;
  /** Bar numbers (1-based) where the tab and the recording barely agree, at most a handful. */
  weakBars: number[];
  /** Stretches the recording plays that the tab does not have. */
  jumps: number;
}

/** Below this the tab and the recording are probably not the same song, or version. */
export const LOW_AGREEMENT = 0.5;

export function summariseSync(songId: string, sync: ScoreSync): AutoSyncSummary {
  const weak = sync.result.bars
    .filter((b) => b.agreement < 0.35)
    .map((b) => b.barIndex + 1)
    .filter((n, i, all) => all.indexOf(n) === i);
  return {
    songId,
    agreement: sync.result.agreement,
    bars: sync.result.bars.length,
    beatsPerQuarter: sync.result.beatsPerQuarter,
    trackName: sync.trackName,
    weakBars: weak.slice(0, 8),
    jumps: sync.anchors.length - sync.result.bars.length,
  };
}
