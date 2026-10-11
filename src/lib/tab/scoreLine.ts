/**
 * The bass line of a score as the aligner reads it: bars in playback order (repeats played
 * out), each with the notes struck in it.
 *
 * Reads alphaTab's model directly, so a Guitar Pro file, MusicXML or alphaTex all come out the
 * same. Plain data comes out, so the aligner can be tested without alphaTab.
 */

import type { model } from '@coderline/alphatab';

export interface ScoreNote {
  /** Ticks from the start of the bar (960 per quarter note). */
  at: number;
  /** How long it sounds, ties included. */
  length: number;
  midi: number;
}

export interface ScoreBar {
  /** Index of the bar in the score (bar 1 is 0). */
  index: number;
  /** Playback tick at which this pass through the bar starts (repeats played out). */
  tick: number;
  /** Length in ticks. */
  ticks: number;
  notes: ScoreNote[];
}

/** A pass through a bar, as alphaTab's tick lookup reports playback order. */
export interface PlayedBar {
  start: number;
  end: number;
  masterBar: { index: number };
}

const BASS_PROGRAMS = new Set([32, 33, 34, 35, 36, 37, 38, 39]);

/** Whether a track reads as a bass: a bass sound, or a lowest string at or under B1. */
export function looksLikeBass(track: model.Track): boolean {
  if (track.staves.some((s) => s.isPercussion)) return false;
  if (BASS_PROGRAMS.has(track.playbackInfo.program)) return true;
  const tuning = track.staves[0]?.tuning ?? [];
  return tuning.length > 0 && Math.min(...tuning) <= 35;
}

/** The bass track: the preferred one if it looks like a bass, else the first that does. */
export function pickBassTrack(score: model.Score, preferred: number): number {
  const tracks = score.tracks;
  if (tracks[preferred] && looksLikeBass(tracks[preferred])) return preferred;
  const found = tracks.findIndex(looksLikeBass);
  return found >= 0 ? found : Math.min(Math.max(0, preferred), tracks.length - 1);
}

/**
 * The bass line, bar by bar in playback order. `played` is alphaTab's playback order (the
 * tick lookup's master bars); without it the bars are taken as written, start to end.
 */
export function scoreBars(score: model.Score, trackIndex: number, played?: readonly PlayedBar[]): ScoreBar[] {
  const track = score.tracks[trackIndex];
  if (!track) return [];
  const staff = track.staves[0];

  // Notes per bar as written; a note tied over from the bar before lengthens that note
  // rather than counting as a new pluck.
  const written = new Map<number, ScoreNote[]>();
  let last: ScoreNote | null = null;
  for (const bar of staff.bars) {
    const notes: ScoreNote[] = [];
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        for (const note of beat.notes) {
          if (note.isTieDestination) {
            if (last) last.length += beat.playbackDuration;
            continue;
          }
          last = { at: beat.playbackStart, length: beat.playbackDuration, midi: note.realValue };
          notes.push(last);
        }
      }
    }
    notes.sort((a, b) => a.at - b.at);
    written.set(bar.index, notes);
  }

  const order: PlayedBar[] =
    played && played.length
      ? [...played]
      : score.masterBars.map((mb) => ({ start: mb.start, end: mb.start + mb.calculateDuration(), masterBar: { index: mb.index } }));
  return order.map((p) => ({
    index: p.masterBar.index,
    tick: p.start,
    ticks: p.end - p.start,
    notes: written.get(p.masterBar.index) ?? [],
  }));
}
