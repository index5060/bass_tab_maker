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
  /** Slots per beat of the grid `notes` are on. */
  subdivision: number;
  /**
   * How each beat is divided: 4 (sixteenths) or 3 (triplet eighths, written as triplets). Each
   * must divide `subdivision`. Absent: every beat in four.
   */
  divisions?: readonly number[];
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

/** Lengths (in sixteenths) that have a single written value: [sixteenths, duration, dotted]. */
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

/** Split a length (sixteenths) into written values, largest first. */
function pieces16(length: number): Array<[number, number, boolean]> {
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
      for (const [slots] of pieces16(toBeat)) out.push(slots);
      at += toBeat;
      left -= toBeat;
      continue;
    }
    // On a beat: whole beats as one value where one exists (1, 2, 3, 4 beats).
    const beats = Math.floor(left / perBeat);
    if (beats > 0) {
      for (const [slots] of pieces16(beats * perBeat)) out.push(slots);
      at += beats * perBeat;
      left -= beats * perBeat;
    } else {
      for (const [slots] of pieces16(left)) out.push(slots);
      left = 0;
    }
  }
  return out;
}

/**
 * Written values within a beat in three, as [triplet eighths, token suffix, duration]: a third
 * and two thirds of a beat are triplets; the whole beat is a plain quarter.
 */
const TRIPLET_VALUES: Array<[number, number, string]> = [
  [3, 4, ''],
  [2, 4, '{tu 3}'],
  [1, 8, '{tu 3}'],
];

export function writeTab(input: WriteInput): WriteResult {
  const { beats, beatsPerBar, subdivision } = input;
  const divisionOf = (beat: number) => input.divisions?.[beat] ?? 4;
  if (subdivision % 4 !== 0 || (input.divisions ?? []).some((d) => subdivision % d !== 0)) {
    throw new Error(`박당 ${subdivision}칸 격자에 박 나눔 ${[...new Set(input.divisions)].join('/')}을 적을 수 없습니다.`);
  }
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
    const smallest = subdivision / divisionOf(Math.floor(n.startSlot / subdivision));
    return { ...n, endSlot: Math.max(end, n.startSlot + smallest) };
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
  const sixteenth = subdivision / 4;
  const tripletEighth = subdivision / 3;
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

    let duration = 0;
    const emit = (value: number, text: string) => {
      if (value !== duration) {
        tokens.push(`:${value}`);
        duration = value;
      }
      tokens.push(text);
    };

    // The bar in segments: runs of beats in four, written in sixteenths, and single beats in
    // three, written as triplets. A note crossing from one into the next is tied.
    const firstBeat = bar * beatsPerBar;
    for (let beat = firstBeat; beat < firstBeat + beatsPerBar; ) {
      const triplet = divisionOf(beat) === 3;
      let endBeat = beat + 1;
      if (!triplet) while (endBeat < firstBeat + beatsPerBar && divisionOf(endBeat) !== 3) endBeat++;
      const from = beat * subdivision;
      const to = endBeat * subdivision;
      // What sounds in [from, to): pieces of notes, and the rests between them.
      const pieces: Array<{ start: number; end: number; text: string | null; tie: string | null }> = [];
      let at = from;
      for (const n of timeline) {
        if (n.endSlot <= from || n.startSlot >= to) continue;
        const start = Math.max(n.startSlot, from);
        const end = Math.min(n.endSlot, to);
        if (start > at) pieces.push({ start: at, end: start, text: null, tie: null });
        if (end <= start) continue;
        pieces.push({ start, end, text: n.startSlot >= from ? `${n.fret}.${n.string}` : `-.${n.string}`, tie: `-.${n.string}` });
        at = end;
      }
      if (at < to) pieces.push({ start: at, end: to, text: null, tie: null });

      for (const piece of pieces) {
        if (triplet) {
          let left = Math.max(1, Math.round((piece.end - piece.start) / tripletEighth));
          let first = true;
          while (left > 0) {
            const [eighths, value, suffix] = TRIPLET_VALUES.find(([e]) => e <= left)!;
            const text = piece.text === null ? 'r' : first ? piece.text : piece.tie!;
            emit(value, `${text}${suffix}`);
            left -= eighths;
            first = false;
          }
        } else {
          const start = Math.round((piece.start - from) / sixteenth);
          const length = Math.max(1, Math.round((piece.end - piece.start) / sixteenth));
          const values =
            piece.text === null ? restPieces(start, length, 4).map((v) => VALUES.find(([s]) => s === v)!) : pieces16(length);
          let first = true;
          for (const [, value, dotted] of values) {
            const text = piece.text === null ? 'r' : first ? piece.text : piece.tie!;
            emit(value, dotted ? `${text}{d}` : text);
            first = false;
          }
        }
      }
      beat = endBeat;
    }
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
