/**
 * Write the fretted notes as alphaTex, bar by bar, against the tracked beats.
 *
 * Bars start on downbeats (meter.ts), so a riff that starts on "one" is written starting on
 * one. Notes that cross a bar line are tied rather than cut short, and the tempo is written
 * where the band actually changed it. Alongside the text come sync anchors — the recording's
 * time of every bar line — so playback follows the recording itself, not an idealised tempo.
 */

import type { FrettedNote } from './frets';

export interface WriteInput {
  title: string;
  notes: FrettedNote[];
  /** Beat times (s); beat 0 is the first beat of bar 1. */
  beats: number[];
  beatsPerBar: number;
  subdivision: number;
  /** Only bars whose downbeat lies inside these beats get a sync anchor (the rest were extrapolated). */
  trackedBeats: { first: number; last: number };
  /** A tempo the user gave: written at the top when the beats agree with it (within 3%). */
  bpm?: number;
}

export interface BarAnchor {
  barIndex: number;
  /** alphaTab ticks at the bar line (960 per quarter note). */
  tick: number;
  /** Where that bar line is in the recording. */
  audioMs: number;
}

export interface WriteResult {
  alphaTex: string;
  anchors: BarAnchor[];
  bars: number;
  /** Tempo written at the start. */
  bpm: number;
}

const TICKS_PER_QUARTER = 960;

/** Lengths (in slots of a 4-per-beat grid) that have a single written value: [slots, duration, dotted]. */
const VALUES: Array<[number, number, boolean]> = [
  [16, 1, false],
  [12, 2, true],
  [8, 2, false],
  [6, 4, true],
  [4, 4, false],
  [3, 8, true],
  [2, 8, false],
  [1, 16, false],
];

/** Split a length into written values, largest first. */
function pieces(length: number): Array<[number, number, boolean]> {
  const out: Array<[number, number, boolean]> = [];
  let left = length;
  while (left > 0) {
    const value = VALUES.find(([slots]) => slots <= left)!;
    out.push(value);
    left -= value[0];
  }
  return out;
}

/**
 * A rest from `start` (slot within the bar) for `length` slots, broken at beat boundaries so
 * it reads as rests on beats rather than one oddly placed long value — except that whole free
 * beats are grouped.
 */
function restPieces(start: number, length: number, perBeat: number): number[] {
  const out: number[] = [];
  let at = start;
  let left = length;
  while (left > 0) {
    const toBeat = at % perBeat === 0 ? left : Math.min(left, perBeat - (at % perBeat));
    if (at % perBeat !== 0) {
      // Fill up to the beat with the biggest values that fit.
      for (const [slots] of pieces(toBeat)) out.push(slots);
      at += toBeat;
      left -= toBeat;
      continue;
    }
    // On a beat: whole beats as one value where one exists (1, 2, 3, 4 beats).
    const beats = Math.floor(left / perBeat);
    if (beats > 0) {
      for (const [slots] of pieces(beats * perBeat)) out.push(slots);
      at += beats * perBeat;
      left -= beats * perBeat;
    } else {
      for (const [slots] of pieces(left)) out.push(slots);
      left = 0;
    }
  }
  return out;
}

export function writeTab(input: WriteInput): WriteResult {
  const { beats, beatsPerBar, subdivision } = input;
  if (subdivision !== 4) throw new Error('지금은 박당 4칸(16분음표) 격자만 씁니다.');
  const perBar = beatsPerBar * subdivision;
  const lastSlot = Math.max(0, ...input.notes.map((n) => n.endSlot));
  const bars = Math.max(1, Math.ceil(Math.max(lastSlot, (beats.length - 1) * subdivision) / perBar));

  // Notes as a timeline, with short gaps closed: a bass note is written until the next one
  // unless the player clearly rested (a beat or more of silence). The detected end of a note
  // is when it stopped sounding, which for a plucked string is well before the player let go.
  const notes = [...input.notes].sort((a, b) => a.startSlot - b.startSlot);
  const timeline = notes.map((n, i) => {
    const next = notes[i + 1]?.startSlot ?? Infinity;
    let end = Math.min(n.endSlot, next);
    if (next - end > 0 && next - end < subdivision) end = next;
    return { ...n, endSlot: Math.max(end, n.startSlot + 1) };
  });

  const barTempo = (bar: number) => {
    const first = bar * beatsPerBar;
    const lastBeat = Math.min(beats.length - 1, first + beatsPerBar);
    if (lastBeat <= first) return 60 / (beats[beats.length - 1] - beats[beats.length - 2] || 0.5);
    return (60 * (lastBeat - first)) / (beats[lastBeat] - beats[first]);
  };

  const lines: string[] = [];
  // The tempo at the top is the typical one of the opening bars, not bar 1's alone: the beats
  // before the music starts are extrapolated, and one odd bar should not set the whole song
  // a BPM off.
  const opening = Array.from({ length: Math.min(8, bars) }, (_, b) => barTempo(b)).sort((a, b) => a - b);
  const measured = opening[(opening.length - 1) >> 1];
  let written = Math.round(input.bpm && Math.abs(measured / input.bpm - 1) < 0.03 ? input.bpm : measured);
  const startBpm = written;
  let cursor = 0; // index into timeline
  for (let bar = 0; bar < bars; bar++) {
    const tokens: string[] = [];
    if (bar === 0) tokens.push(`\\ts (${beatsPerBar} 4)`);
    if (bar > 0 || Math.abs(barTempo(0) - written) >= 2) {
      // Only real tempo changes are written: a click-track song gets one marking, a band that
      // pushes and drags gets one where it moved.
      const tempo = Math.round(barTempo(bar));
      if (Math.abs(tempo - written) >= 2) {
        tokens.push(`\\tempo ${tempo}`);
        written = tempo;
      }
    }

    const barStart = bar * perBar;
    const barEnd = barStart + perBar;
    let at = barStart;
    let duration = 0;
    const emit = (slots: number, text: string) => {
      const value = VALUES.find(([s]) => s === slots)!;
      if (value[1] !== duration) {
        tokens.push(`:${value[1]}`);
        duration = value[1];
      }
      tokens.push(value[2] ? `${text}{d}` : text);
    };
    const rest = (from: number, to: number) => {
      for (const slots of restPieces(from - barStart, to - from, subdivision)) emit(slots, 'r');
    };

    // A note carried over from the previous bar continues as a tie.
    while (cursor < timeline.length && timeline[cursor].endSlot <= barStart) cursor++;
    for (let i = cursor; i < timeline.length && timeline[i].startSlot < barEnd; i++) {
      const n = timeline[i];
      const from = Math.max(n.startSlot, barStart);
      if (from > at) rest(at, from);
      const to = Math.min(n.endSlot, barEnd);
      if (to <= from) continue;
      let first = n.startSlot >= barStart;
      for (const [slots] of pieces(to - from)) {
        emit(slots, first ? `${n.fret}.${n.string}` : `-.${n.string}`);
        first = false;
      }
      at = to;
    }
    if (at < barEnd) rest(at, barEnd);
    lines.push(tokens.join(' ') + ' |');
  }

  const anchors: BarAnchor[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const beat = bar * beatsPerBar;
    if (beat < input.trackedBeats.first || beat > input.trackedBeats.last || beat >= beats.length) continue;
    anchors.push({ barIndex: bar, tick: bar * beatsPerBar * TICKS_PER_QUARTER, audioMs: Math.round(beats[beat] * 1000) });
  }

  const title = input.title.replace(/["\\]/g, '');
  const alphaTex = [
    `\\title "${title}"`,
    `\\tempo ${startBpm}`,
    '.',
    '\\track "Bass"',
    '\\instrument 33',
    '\\staff{tabs} \\tuning (G2 D2 A1 E1)',
    ...lines,
    '',
  ].join('\n');
  return { alphaTex, anchors, bars, bpm: startBpm };
}
