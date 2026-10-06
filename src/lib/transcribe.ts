/**
 * Turn a stream of pitch frames into a readable bass tab.
 *
 * Four steps, each of which can be tested on its own:
 *
 *   frames -> notes        group consecutive frames that agree on a pitch
 *   notes  -> quantised    snap onsets and lengths to a 16th-note grid
 *   notes  -> fretboard    choose a string and fret per note, keeping the hand still
 *   notes  -> alphaTex     text alphaTab can render
 *
 * The output is a first draft, not a finished transcription. It gets rhythms roughly right
 * and pitches mostly right, and it is far quicker to correct a draft than to start from an
 * empty staff. Slides, hammer-ons, ghost notes and dead notes are all flattened to plain
 * notes — the detector has no way to tell them apart.
 */

import { hzToMidi, type PitchFrame } from './pitch';

export interface DetectedNote {
  /** Rounded to the nearest semitone. */
  midi: number;
  startMs: number;
  endMs: number;
  /** Mean confidence of the frames that made this note, 0..1. */
  confidence: number;
}

export interface SegmentOptions {
  /** Frames below this are treated as unvoiced. */
  minConfidence?: number;
  /** Frames quieter than this are treated as silence. */
  rmsGate?: number;
  /** Notes shorter than this are dropped as detector chatter. */
  minNoteMs?: number;
  /** How far the pitch may wander before it counts as a new note, in semitones. */
  pitchToleranceSemitones?: number;
  /** Lowest note a 4-string bass can produce; anything under this is an octave error. */
  minMidi?: number;
  maxMidi?: number;
}

const SEGMENT_DEFAULTS: Required<SegmentOptions> = {
  minConfidence: 0.5,
  rmsGate: 0.005,
  minNoteMs: 60,
  pitchToleranceSemitones: 0.8,
  minMidi: 28, // E1, the open E string
  maxMidi: 67, // G4, past the top of a 20-fret G string
};

/**
 * Pick a level gate from the material instead of guessing one.
 *
 * A fixed gate cannot work here. A separated bass stem carries only a slice of the original
 * mix's energy, and how big that slice is depends on the song, the master level and how
 * confident the separator was — so an absolute 0.005 that suits one track silences the next
 * one completely, and the transcriber returns a page of rests with no explanation.
 *
 * Taking a low percentile of the frames that have any level at all puts the gate just above
 * the stem's own noise floor, whatever that happens to be.
 */
export function suggestRmsGate(frames: PitchFrame[]): number {
  const levels = frames.map((f) => f.rms).filter((r) => r > 1e-6).sort((a, b) => a - b);
  if (levels.length === 0) return 0;
  const noiseFloor = levels[Math.floor(levels.length * 0.15)];
  const loud = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.9))];

  // Anchor on the loud end, not the quiet end. A stem with little dynamic range has its low
  // percentile sitting on the signal itself, so scaling that up puts the gate above every
  // note and silences the whole track — which is exactly the page-of-rests failure. The
  // noise floor is allowed to raise the gate, but never past a fraction of the peaks.
  //
  // The fractions are deliberately gentle. Real playing is dynamic — ghost notes, note
  // tails, verses played softer than choruses — and an aggressive gate turned a continuous
  // bass line into scattered fragments, which then fed the grid fit garbage. A missed soft
  // note costs one note; a too-high gate costs whole passages.
  const floorInfluenced = Math.min(noiseFloor * 1.3, loud * 0.12);
  return Math.max(loud * 0.03, floorInfluenced);
}

export interface SegmentStats {
  frames: number;
  voicedFrames: number;
  rawNotes: number;
  droppedTooShort: number;
  droppedOutOfRange: number;
  kept: number;
  medianRms: number;
  medianConfidence: number;
  rmsGateUsed: number;
}

/* --------------------------------------------------------------- segment */

export function segmentNotes(frames: PitchFrame[], options: SegmentOptions = {}): DetectedNote[] {
  return segmentNotesDetailed(frames, options).notes;
}

/**
 * Same as segmentNotes, but says what happened.
 *
 * When the result is an empty score, the useful question is *where* everything went — below
 * the level gate, below the confidence gate, too short, or off the fretboard. Returning
 * counts turns "no notes found" into something the UI can actually explain.
 */
export function segmentNotesDetailed(
  frames: PitchFrame[],
  options: SegmentOptions = {},
): { notes: DetectedNote[]; stats: SegmentStats } {
  const opts = { ...SEGMENT_DEFAULTS, ...options };
  const notes: DetectedNote[] = [];
  let voicedFrames = 0;
  let rawNotes = 0;
  let droppedTooShort = 0;
  let droppedOutOfRange = 0;

  let current: { midis: number[]; confidences: number[]; startMs: number; endMs: number } | null =
    null;

  const close = () => {
    if (!current) return;
    rawNotes++;
    if (current.endMs - current.startMs < opts.minNoteMs) {
      droppedTooShort++;
      current = null;
      return;
    }
    const midi = Math.round(median(current.midis));
    if (midi < opts.minMidi || midi > opts.maxMidi) {
      droppedOutOfRange++;
      current = null;
      return;
    }
    notes.push({
      midi,
      startMs: current.startMs,
      endMs: current.endMs,
      confidence: mean(current.confidences),
    });
    current = null;
  };

  for (const frame of frames) {
    const voiced = frame.hz > 0 && frame.confidence >= opts.minConfidence && frame.rms >= opts.rmsGate;
    if (!voiced) {
      close();
      continue;
    }
    voicedFrames++;

    const midi = hzToMidi(frame.hz);
    if (current && Math.abs(midi - median(current.midis)) <= opts.pitchToleranceSemitones) {
      current.midis.push(midi);
      current.confidences.push(frame.confidence);
      current.endMs = frame.timeMs;
    } else {
      close();
      current = {
        midis: [midi],
        confidences: [frame.confidence],
        startMs: frame.timeMs,
        endMs: frame.timeMs,
      };
    }
  }
  close();

  return {
    notes,
    stats: {
      frames: frames.length,
      voicedFrames,
      rawNotes,
      droppedTooShort,
      droppedOutOfRange,
      kept: notes.length,
      medianRms: median(frames.map((f) => f.rms)),
      medianConfidence: median(frames.map((f) => f.confidence)),
      rmsGateUsed: opts.rmsGate,
    },
  };
}

/* ------------------------------------------------------------ cleanup */

/**
 * Median-smooth the pitch track before segmentation.
 *
 * A plucked bass is harmonically rich, and during the attack or decay YIN occasionally locks
 * onto the second harmonic for a frame or two — an octave-up blip in an otherwise steady
 * note. One blip is enough to split a note in half and leave a wrong-octave fragment in the
 * tab. A short median over the voiced neighbours erases isolated flips while leaving genuine
 * note changes (which persist for many frames) untouched.
 */
export function medianSmoothFrames(frames: PitchFrame[], radius = 2): PitchFrame[] {
  if (radius <= 0) return frames;
  return frames.map((frame, i) => {
    if (frame.hz <= 0) return frame;
    const window: number[] = [];
    for (let j = Math.max(0, i - radius); j <= Math.min(frames.length - 1, i + radius); j++) {
      if (frames[j].hz > 0) window.push(frames[j].hz);
    }
    // Too few voiced neighbours to vote — leave the frame alone rather than inventing one.
    if (window.length < radius + 1) return frame;
    const m = median(window);
    return m === frame.hz ? frame : { ...frame, hz: m };
  });
}

/**
 * Merge a note that resumes at the same pitch after a tiny gap.
 *
 * The level gate briefly loses a decaying note and then finds it again, which used to leave
 * two short notes where the player held one. Only identical pitches across a sub-100ms gap
 * merge, so genuine repeated notes (which have a fresh attack and a longer gap) survive.
 */
export function mergeNearbyNotes(notes: DetectedNote[], maxGapMs = 80): DetectedNote[] {
  const out: DetectedNote[] = [];
  for (const note of notes) {
    const prev = out[out.length - 1];
    if (prev && prev.midi === note.midi && note.startMs - prev.endMs <= maxGapMs) {
      prev.endMs = note.endMs;
      prev.confidence = (prev.confidence + note.confidence) / 2;
    } else {
      out.push({ ...note });
    }
  }
  return out;
}

/* --------------------------------------------------------- octave repair */

/**
 * Pull single notes that jumped an octave back down.
 *
 * Autocorrelation pitch detection slips to the second harmonic when the fundamental of a
 * bass note is weak — which on a separated stem is often, because separation eats low end.
 * The slip lasts a whole note rather than a frame or two, so frame-level median smoothing
 * never sees it; it arrives as a clean, confident, wrong note.
 *
 * Measured on a real transcription: 28 of 552 notes (5%) sat an octave above both of their
 * neighbours. In a tab that reads as the bassist suddenly jumping to the 12th fret and back
 * for one note, which is exactly the kind of wrongness that makes the whole page untrustworthy.
 *
 * The conservative part is not repairing real octave leaps, which bass players do constantly
 * (disco octaves, funk pops). Four conditions have to hold at once: an octave above BOTH
 * neighbours, dropping it lands within a tone of a neighbour, it is contiguous with both in
 * time, and it is shorter than both. A real octave pop fails the last one — in `E1 E2 E1` the
 * three notes are about equally long, while a harmonic slip is a brief flicker inside one
 * sustained note.
 */
export function repairOctaveJumps(notes: DetectedNote[], maxGapMs = 40): DetectedNote[] {
  if (notes.length < 3) return notes.map((n) => ({ ...n }));
  const out = notes.map((n) => ({ ...n }));

  for (let i = 1; i < out.length - 1; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const next = out[i + 1];

    const aboveBoth = cur.midi - prev.midi >= 10 && cur.midi - next.midi >= 10;
    if (!aboveBoth) continue;

    const dropped = cur.midi - 12;
    const fitsNeighbour = Math.abs(dropped - prev.midi) <= 2 || Math.abs(dropped - next.midi) <= 2;
    if (!fitsNeighbour) continue;

    const contiguous =
      cur.startMs - prev.endMs <= maxGapMs && next.startMs - cur.endMs <= maxGapMs;
    if (!contiguous) continue;

    // The one that saves genuine octave playing: a real leap is not a blip inside a longer note.
    const duration = cur.endMs - cur.startMs;
    const shorterThanBoth =
      duration < prev.endMs - prev.startMs && duration < next.endMs - next.startMs;
    if (!shorterThanBoth) continue;

    cur.midi = dropped;
  }
  return out;
}

/* ---------------------------------------------------------- tempo search */

export interface TempoSearchResult {
  bpm: number;
  /** How the beat divides. 3 means the recording shuffles. */
  subdivision: Subdivision;
  /** Where slot 0 sits, in milliseconds. */
  offsetMs: number;
  /**
   * Whether a tempo was *found* or merely *returned*, 0..1. Above ~0.35 is a real lock.
   *
   * Raw clustering will not do here, and finding that out cost a test. Search enough candidate
   * grids and some grid fits any handful of onsets: ten random times scored 0.75 out of 1,
   * which would have made a meaningless tempo look certain. So this is measured against what
   * the best of that many candidates would score on random onsets — a floor that falls as the
   * square root of the note count. The 552-note song scored 0.80 against a floor of 0.11; the
   * ten random onsets scored 0.75 against a floor of 0.79, and come out at zero.
   */
  strength: number;
  meanAbsErrorMs: number;
}

/** Where a beat feels natural to sit. Only ever a tiebreak between readings that fit equally. */
const PREFERRED_BPM = 110;

/** How the beat is cut up. 4 = straight sixteenths, 3 = a shuffle's triplet eighths. */
export type Subdivision = 3 | 4;

/**
 * Find the tempo by testing every plausible grid against all the onsets at once.
 *
 * Replaces taking the median inter-onset gap, which looked reasonable and was badly wrong:
 * the median is not a musical quantity, and in a line mixing eighths and quarters it lands
 * between the two and belongs to neither.
 *
 * The test is circular concentration. Map each onset onto its phase within a candidate slot
 * and sum the unit vectors: onsets that land on the grid point the same way and add up, ones
 * scattered across the slot cancel. It reads every onset in the song rather than a summary of
 * the gaps between them, and costs one pass per candidate — atan2 of the sum *is* the best
 * phase, so there is no inner search.
 *
 * What it searches for is the *slot*, not the tempo. Those are different questions and
 * conflating them was the second bug. See `chooseBeat` below.
 */
export function searchTempo(
  notes: DetectedNote[],
  options: { minBpm?: number; maxBpm?: number } = {},
): TempoSearchResult {
  const minBpm = options.minBpm ?? 60;
  const maxBpm = options.maxBpm ?? 200;
  const onsets = notes.map((n) => n.startMs);

  // Too few onsets and concentration is meaningless — three points lie on almost any grid.
  if (onsets.length < 8) {
    const bpm = estimateBpm(notes);
    return { bpm, subdivision: 4, ...phaseFor(onsets, bpm, 4) };
  }

  // Every slot a bass line plausibly sits on, from a fast sixteenth to a slow triplet eighth.
  const MIN_SLOT_MS = 70;
  const MAX_SLOT_MS = 320;
  const scan = (from: number, to: number, step: number): { slotMs: number; strength: number } => {
    let best = { slotMs: from, strength: -1 };
    for (let slotMs = from; slotMs <= to; slotMs += step) {
      const strength = concentration(onsets, slotMs);
      if (strength > best.strength) best = { slotMs, strength };
    }
    return best;
  };

  const coarseStep = 0.2;
  const coarse = scan(MIN_SLOT_MS, MAX_SLOT_MS, coarseStep);
  // Real recordings are not metronomic and real tempos are not integers.
  const fine = scan(coarse.slotMs - 0.25, coarse.slotMs + 0.25, 0.01);
  const candidatesTried = (MAX_SLOT_MS - MIN_SLOT_MS) / coarseStep;

  const { bpm, subdivision } = chooseBeat(notes, fine.slotMs, minBpm, maxBpm);

  return {
    bpm,
    subdivision,
    ...phaseFor(onsets, bpm, subdivision),
    strength: aboveChance(fine.strength, onsets.length, candidatesTried),
  };
}

/**
 * Decide what the slot the search found actually *is* — and this is where a whole song can go
 * wrong while every number still looks healthy.
 *
 * A grid of 137ms slots is a fact about the recording. Whether that slot is a sixteenth of a
 * 109 BPM beat or a triplet eighth of a 146 BPM beat is not: both describe the same lines in
 * the same places. The first version assumed four slots to a beat, always, and so reported
 * 109.8 BPM for a song Songsterr marks 146 — because Green Day's "Holiday" shuffles, and a
 * shuffle cuts the beat in three. Every shuffle comes out at exactly three quarters of its
 * real tempo, and the bar lines land on nothing.
 *
 * Onsets alone cannot settle it, so ask the arrangement instead. Bass lines repeat, and they
 * repeat over a whole number of bars — almost always two, four or eight. Measure the riff's
 * repeat period, then keep the beat that makes that period come out as a sensible number of
 * bars. On "Holiday" the riff repeats every 6.56s: that is 3.99 bars at 146 and 2.98 at
 * 109.8, and its half-period is 2.00 bars against 1.49. A phrase and a half is not a thing.
 */
function chooseBeat(
  notes: DetectedNote[],
  slotMs: number,
  minBpm: number,
  maxBpm: number,
): { bpm: number; subdivision: Subdivision } {
  const repeatMs = findRepeatPeriodMs(notes);

  // A beat is some small whole number of slots. 3 and 6 are shuffles, 2 and 4 are straight.
  const candidates: { bpm: number; subdivision: Subdivision; score: number }[] = [];
  for (const slotsPerBeat of [2, 3, 4, 6]) {
    const bpm = 60000 / (slotMs * slotsPerBeat);
    if (bpm < minBpm || bpm > maxBpm) continue;
    const subdivision: Subdivision = slotsPerBeat % 3 === 0 ? 3 : 4;

    // Prefer the tempo a musician would write, but only weakly — this is a tiebreak, and
    // letting it lead is how you talk yourself out of a correct 146.
    let score = Math.exp(-Math.abs(Math.log(bpm / PREFERRED_BPM)));

    // Most music is straight. Reading a beat as three requires evidence, because a shuffle
    // reading is always *available* — any straight grid can be described as a slower one cut
    // in three — and without this the search talks itself into a shuffle on plain rock.
    if (subdivision === 3) score *= 0.75;

    if (repeatMs > 0) {
      const bars = repeatMs / ((60000 / bpm) * 4);
      const nearest = Math.round(bars);
      if (nearest >= 1) {
        const offBy = Math.abs(bars - nearest);
        // Landing on a whole number of bars is the evidence; landing on a power of two is
        // what pop and rock phrases actually do.
        const phrase = [1, 2, 4, 8, 16].includes(nearest) ? 1 : nearest % 2 === 0 ? 0.8 : 0.55;
        score *= phrase * Math.max(0, 1 - offBy * 4);
      }
    }
    candidates.push({ bpm, subdivision, score });
  }

  if (candidates.length === 0) {
    // Nothing musical in range: fall back to the straight reading nearest the preferred tempo.
    let bpm = 60000 / (slotMs * 4);
    while (bpm < minBpm) bpm *= 2;
    while (bpm > maxBpm) bpm /= 2;
    return { bpm, subdivision: 4 };
  }
  candidates.sort((a, b) => b.score - a.score);
  return { bpm: candidates[0].bpm, subdivision: candidates[0].subdivision };
}

/**
 * How long before the line starts saying the same thing again, in milliseconds.
 *
 * Sampling the detected pitch onto a fixed time grid and sliding it against itself. Matching
 * on exact pitch rather than distance keeps a stray octave from counting as a near miss, and
 * only frames where both copies have a note are counted, so silence cannot manufacture a
 * match. Returns 0 when nothing repeats clearly enough to base a decision on.
 */
export function findRepeatPeriodMs(
  notes: DetectedNote[],
  options: { minMs?: number; maxMs?: number; stepMs?: number } = {},
): number {
  const stepMs = options.stepMs ?? 20;
  const minMs = options.minMs ?? 800;
  const maxMs = options.maxMs ?? 16000;
  if (notes.length < 16) return 0;

  const endMs = notes[notes.length - 1].endMs;
  const frames = Math.ceil(endMs / stepMs);
  if (frames < 200) return 0;

  const pitch = new Int16Array(frames);
  for (const note of notes) {
    const from = Math.max(0, Math.floor(note.startMs / stepMs));
    const to = Math.min(frames, Math.ceil(note.endMs / stepMs));
    for (let i = from; i < to; i++) pitch[i] = note.midi;
  }

  let best = { lag: 0, score: 0 };
  const scores: number[] = [];
  const maxLag = Math.min(frames - 1, Math.floor(maxMs / stepMs));
  for (let lag = Math.floor(minMs / stepMs); lag <= maxLag; lag++) {
    let same = 0;
    let both = 0;
    for (let i = 0; i + lag < frames; i++) {
      if (pitch[i] && pitch[i + lag]) {
        both++;
        if (pitch[i] === pitch[i + lag]) same++;
      }
    }
    // Too little overlap and the ratio is noise from a handful of frames.
    if (both < 200) continue;
    const score = same / both;
    scores.push(score);
    if (score > best.score) best = { lag, score };
  }
  if (scores.length < 8) return 0;

  // A period only means something if it beats the lags around it. A line that stays on one
  // note matches itself perfectly at *every* lag, and reading a phrase length out of that
  // flat landscape is how a unit test caught this reporting a confident, meaningless number.
  const typical = scores.slice().sort((a, b) => a - b)[scores.length >> 1];
  if (best.score - typical < 0.1) return 0;

  // Below this, "the riff" is not repeating in any way worth reasoning from.
  if (best.score < 0.25) return 0;

  // Take the shortest lag that explains the repetition, not the best-scoring one. Every
  // multiple of a true period is also a period, and which multiple wins is decided by where
  // the sampling grid happens to land — a coin toss. It cost a real decision: a two-bar riff
  // came back as six bars, "six" is not a phrase length, and the tempo search preferred a
  // reading that made it four. The fundamental is what carries the musical meaning.
  const scoreAt = (lag: number): number => {
    let same = 0;
    let both = 0;
    for (let i = 0; i + lag < frames; i++) {
      if (pitch[i] && pitch[i + lag]) {
        both++;
        if (pitch[i] === pitch[i + lag]) same++;
      }
    }
    return both < 200 ? 0 : same / both;
  };
  const minLag = Math.floor(minMs / stepMs);
  let fundamental = best.lag;
  for (let divisor = 8; divisor >= 2; divisor--) {
    const candidate = Math.round(best.lag / divisor);
    if (candidate < minLag) continue;
    if (scoreAt(candidate) >= best.score - 0.05) {
      fundamental = candidate;
      break;
    }
  }
  return fundamental * stepMs;
}

/**
 * Discount the clustering score by what the best of N candidate grids scores on noise.
 *
 * Random phases give a resultant that shrinks as 1/sqrt(count); taking the best of many
 * candidates pushes that up by roughly sqrt(ln(candidates)). Treating the candidates as
 * independent overstates the floor a little, which is the safe direction for a number whose
 * whole job is to admit when it does not know.
 */
function aboveChance(raw: number, count: number, candidates: number): number {
  if (count <= 1) return 0;
  const floor = Math.min(0.99, Math.sqrt(Math.log(Math.max(2, candidates)) / count));
  return Math.max(0, Math.min(1, (raw - floor) / (1 - floor)));
}

/** Sum unit vectors of each onset's position within a slot. 1 = all on the line, 0 = scattered. */
function concentration(onsets: number[], slotMs: number): number {
  let re = 0;
  let im = 0;
  for (const onset of onsets) {
    const angle = (2 * Math.PI * (((onset % slotMs) + slotMs) % slotMs)) / slotMs;
    re += Math.cos(angle);
    im += Math.sin(angle);
  }
  return Math.hypot(re, im) / onsets.length;
}

/**
 * Best phase for a known tempo, and how well the onsets sit on it.
 *
 * Worth having separately from `fitGrid`'s phase-only mode, which averages signed residuals.
 * Averaging is not the same as minimising absolute error and a handful of loose onsets drag
 * it: on a real transcription, least-squares phase scored 38.6ms against this method's 11.5ms
 * for the very same tempo. Circular mean handles the wrap-around the way the problem actually
 * works — a slot is a circle, not a line.
 */
export function gridPhase(
  notes: DetectedNote[],
  bpm: number,
  subdivision: Subdivision = 4,
): { offsetMs: number; strength: number; meanAbsErrorMs: number } {
  const found = phaseFor(
    notes.map((n) => n.startMs),
    bpm,
    subdivision,
  );
  // Discounted the same way as the search so the two numbers mean the same thing to a reader,
  // with the candidate count at its floor — nothing was searched here, the tempo was given.
  return { ...found, strength: aboveChance(found.strength, notes.length, 2) };
}

function phaseFor(
  onsets: number[],
  bpm: number,
  subdivision: Subdivision = 4,
): { offsetMs: number; strength: number; meanAbsErrorMs: number } {
  const slot = 60000 / bpm / subdivision;
  if (onsets.length === 0) return { offsetMs: 0, strength: 0, meanAbsErrorMs: 0 };

  let re = 0;
  let im = 0;
  for (const onset of onsets) {
    const angle = (2 * Math.PI * (((onset % slot) + slot) % slot)) / slot;
    re += Math.cos(angle);
    im += Math.sin(angle);
  }
  const offsetMs = (((Math.atan2(im, re) / (2 * Math.PI)) * slot) % slot + slot) % slot;

  let error = 0;
  for (const onset of onsets) {
    const r = (((onset - offsetMs) % slot) + slot) % slot;
    error += Math.min(r, slot - r);
  }
  return {
    offsetMs,
    strength: Math.hypot(re, im) / onsets.length,
    meanAbsErrorMs: error / onsets.length,
  };
}

/* ------------------------------------------------------------- grid fit */

export interface GridFit {
  bpm: number;
  /** Phase of the grid in milliseconds — where sixteenth slot 0 actually sits. */
  offsetMs: number;
  /** Mean |onset - nearest grid line| after the fit. The honesty number. */
  meanAbsErrorMs: number;
}

/**
 * Fit the sixteenth-note grid to the onsets instead of trusting a guessed tempo.
 *
 * This is the fix for the biggest failure mode of the first version: a tempo estimate that is
 * off by even 1% drifts by a beat every ~25 bars, so notes late in the song land in entirely
 * wrong bars and the whole tab reads as nonsense. Quantising against a slightly-wrong grid is
 * not slightly wrong — it compounds.
 *
 * Alternate between assigning each onset to its nearest slot and least-squares refitting
 * (slot width, phase) to those assignments. Converges in a few rounds when the initial guess
 * is within a few percent, which estimateBpm manages. With `fixedBpm` only the phase is
 * fitted — for when the user typed the BPM in and is right about it.
 */
export function fitGrid(
  notes: DetectedNote[],
  initialBpm: number,
  options: { fixedBpm?: boolean } = {},
): GridFit {
  const initialSix = 60000 / initialBpm / 4;
  let six = initialSix;
  let offset = 0;

  const errorNow = (): number =>
    notes.length
      ? notes.reduce((sum, n) => {
          const k = Math.round((n.startMs - offset) / six);
          return sum + Math.abs(n.startMs - (offset + k * six));
        }, 0) / notes.length
      : 0;

  if (notes.length < 3) return { bpm: initialBpm, offsetMs: 0, meanAbsErrorMs: errorNow() };

  /**
   * Assign slot numbers incrementally, from each onset's distance to the previous one,
   * rather than dividing every onset by the guess directly.
   *
   * The direct way breaks on exactly the case this function exists for: with a 1% tempo
   * error the accumulated drift passes half a slot after only a few seconds, the later
   * onsets get assigned to the wrong slots, and the regression then faithfully fits the
   * wrong assignment — returning the bad guess it started with. Inter-onset gaps are short,
   * so their rounding survives a several-percent error, and summing them keeps the absolute
   * slot numbers right for the whole song.
   */
  const assign = (): number[] => {
    const ks: number[] = [Math.max(0, Math.round((notes[0].startMs - offset) / six))];
    for (let i = 1; i < notes.length; i++) {
      ks.push(ks[i - 1] + Math.round((notes[i].startMs - notes[i - 1].startMs) / six));
    }
    return ks;
  };

  for (let iteration = 0; iteration < 5; iteration++) {
    const ks = assign();

    if (options.fixedBpm) {
      // Only the phase moves; the slot width is the user's word.
      offset = notes.reduce((sum, n, i) => sum + (n.startMs - ks[i] * six), 0) / notes.length;
      continue;
    }

    let sumK = 0;
    let sumT = 0;
    let sumKT = 0;
    let sumKK = 0;
    for (let i = 0; i < notes.length; i++) {
      sumK += ks[i];
      sumT += notes[i].startMs;
      sumKT += ks[i] * notes[i].startMs;
      sumKK += ks[i] * ks[i];
    }
    const n = notes.length;
    const denom = n * sumKK - sumK * sumK;
    if (Math.abs(denom) < 1e-6) break; // every onset in one slot — nothing to fit

    const nextSix = (n * sumKT - sumK * sumT) / denom;
    const nextOffset = (sumT - nextSix * sumK) / n;
    if (!Number.isFinite(nextSix) || nextSix < 20 || nextSix > 2000) break;
    six = nextSix;
    offset = nextOffset;
  }

  const bpm = 60000 / (six * 4);
  // A fit that wandered out of musical range learned noise, not tempo. Keep the guess.
  if (bpm < 40 || bpm > 300) {
    six = initialSix;
    offset = 0;
    return { bpm: initialBpm, offsetMs: 0, meanAbsErrorMs: errorNow() };
  }
  return { bpm, offsetMs: offset, meanAbsErrorMs: errorNow() };
}

/* -------------------------------------------------------------- quantise */

export interface QuantizedNote extends DetectedNote {
  /** Onset in sixteenth notes from the start. */
  startSixteenths: number;
  /** Length in sixteenth notes, always one of 1, 2, 4, 8, 16. */
  lengthSixteenths: number;
}

/** Lengths alphaTex can write without ties or dots. Keeps the draft readable. */
const CLEAN_LENGTHS = [1, 2, 4, 8, 16];

/**
 * Snap to a sixteenth-note grid.
 *
 * Lengths are rounded to the nearest clean power of two rather than transcribed exactly:
 * an honest 7.3-sixteenth note would need a tie, and a page of ties is harder to read than a
 * slightly rounded rhythm you can fix by ear.
 */
export function quantizeNotes(
  notes: DetectedNote[],
  bpm: number,
  offsetMs = 0,
  subdivision: Subdivision = 4,
): QuantizedNote[] {
  if (bpm <= 0) throw new Error('BPM은 0보다 커야 합니다.');
  const beatMs = 60000 / bpm;
  const slotMs = beatMs / subdivision;

  const out: QuantizedNote[] = [];
  let previousEnd = -1;

  for (const note of notes) {
    let start = toSixteenth(Math.round((note.startMs - offsetMs) / slotMs), subdivision);
    if (start < 0) start = 0;
    // Never let a rounded onset land on or before the previous note's end.
    if (start <= previousEnd) start = previousEnd;

    const endSlot = Math.round((note.endMs - offsetMs) / slotMs);
    const rawLength = Math.max(1, toSixteenth(endSlot, subdivision) - start);
    const length = nearestClean(rawLength);

    out.push({ ...note, startSixteenths: start, lengthSixteenths: length });
    previousEnd = start + length;
  }

  return out;
}

/**
 * Put a slot of a shuffle onto the sixteenth grid everything downstream counts in.
 *
 * A shuffle is *notated* as straight eighths with a feel marking at the top of the page, not
 * as a page of triplet brackets — that is what Songsterr does and what every fake book does,
 * because triplet brackets on every beat are unreadable. So the three slots of a beat land on
 * sixteenths 0, 1 and 2: the first and third become the two eighths a reader expects, and the
 * middle slot, which a shuffle rarely uses, keeps a place of its own instead of colliding.
 */
function toSixteenth(slot: number, subdivision: Subdivision): number {
  if (subdivision === 4) return slot;
  const beat = Math.floor(slot / 3);
  const within = ((slot % 3) + 3) % 3;
  return beat * 4 + within;
}

/**
 * Hold each note until the next one starts.
 *
 * Without this the tab comes out as confetti — a rest between every single note, which is how
 * the first real transcriptions looked and nothing like how anyone writes bass. The cause is
 * that a detected duration is how long the note stayed *audible*, and a plucked bass note
 * decays: the detector cuts it well before the player lifts a finger, and the leftover becomes
 * a rest. A human transcriber writes the note as lasting until the next one.
 *
 * Gaps longer than the limit are left alone, because those are real: a bar the bassist sits
 * out has to stay a bar of rest, or the tab claims a note was ringing through it.
 */
export function fillDurations(notes: QuantizedNote[], maxFillSixteenths = 4): QuantizedNote[] {
  const out = notes.map((n) => ({ ...n }));
  for (let i = 0; i < out.length - 1; i++) {
    const gap = out[i + 1].startSixteenths - (out[i].startSixteenths + out[i].lengthSixteenths);
    if (gap <= 0 || gap > maxFillSixteenths) continue;
    out[i].lengthSixteenths = nearestCleanAtMost(
      out[i + 1].startSixteenths - out[i].startSixteenths,
    );
  }
  return out;
}

function nearestClean(value: number): number {
  let best = CLEAN_LENGTHS[0];
  let bestDistance = Infinity;
  for (const candidate of CLEAN_LENGTHS) {
    const distance = Math.abs(Math.log2(Math.max(value, 0.25) / candidate));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/* ------------------------------------------------------------- fretboard */

/** Open-string MIDI numbers, low to high: E1, A1, D2, G2. */
export const BASS_TUNING = [28, 33, 38, 43];
const MAX_FRET = 20;

export interface FrettedNote extends QuantizedNote {
  /** alphaTab numbers strings from the highest, so 1 = G and 4 = E. */
  string: number;
  fret: number;
}

/**
 * Choose where on the neck each note is played.
 *
 * A note can sit in up to four places, and picking the lowest fret every time produces a tab
 * that jumps across the neck between consecutive notes. Cost is dominated by distance from
 * where the hand already is, with a small pull towards lower frets to stop it drifting up.
 */
export function mapToFretboard(
  notes: QuantizedNote[],
  tuning: number[] = BASS_TUNING,
): FrettedNote[] {
  const out: FrettedNote[] = [];
  let handPosition = 2; // Most bass lines start near the bottom of the neck.

  for (const note of notes) {
    let best: { string: number; fret: number; cost: number } | null = null;

    for (let stringIndex = 0; stringIndex < tuning.length; stringIndex++) {
      const fret = note.midi - tuning[stringIndex];
      if (fret < 0 || fret > MAX_FRET) continue;

      const cost = Math.abs(fret - handPosition) + fret * 0.15;
      if (!best || cost < best.cost) {
        // alphaTab counts strings from the top: index 0 (low E) is string 4.
        best = { string: tuning.length - stringIndex, fret, cost };
      }
    }

    if (!best) continue; // Outside the instrument's range entirely.
    out.push({ ...note, string: best.string, fret: best.fret });
    // Open strings say nothing about where the hand is, so do not move it there.
    if (best.fret > 0) handPosition = best.fret;
  }

  return out;
}

/* -------------------------------------------------------------- alphaTex */

const SIXTEENTHS_TO_TOKEN: Record<number, number> = { 1: 16, 2: 8, 4: 4, 8: 2, 16: 1 };

export interface TexOptions {
  /** 'shuffle' adds the feel marking that lets straight eighths be read as swung. */
  feel?: 'shuffle';
  title: string;
  bpm: number;
  /** 16 sixteenths per bar in 4/4. */
  sixteenthsPerBar?: number;
  /** Pad the score out to at least this many bars so playback covers the whole recording. */
  minBars?: number;
}

/**
 * Render notes as alphaTex.
 *
 * Walks the timeline bar by bar in sixteenth-note slots, writing a note where one starts and
 * a rest everywhere else, so the bars always add up even when the detector missed something.
 */
export function toAlphaTex(notes: FrettedNote[], options: TexOptions): string {
  const sixteenthsPerBar = options.sixteenthsPerBar ?? 16;
  const minBars = Math.max(1, options.minBars ?? 1);

  const lastSixteenth = notes.reduce(
    (max, n) => Math.max(max, n.startSixteenths + n.lengthSixteenths),
    0,
  );
  const barCount = Math.max(minBars, Math.ceil(lastSixteenth / sixteenthsPerBar) || 1);

  const byStart = new Map<number, FrettedNote>();
  for (const note of notes) if (!byStart.has(note.startSixteenths)) byStart.set(note.startSixteenths, note);

  const bars: string[] = [];
  let currentDurationToken = 0;

  for (let bar = 0; bar < barCount; bar++) {
    const tokens: string[] = [];
    let slot = 0;

    while (slot < sixteenthsPerBar) {
      const absolute = bar * sixteenthsPerBar + slot;
      const note = byStart.get(absolute);

      // Never let a note run past the barline — trim it instead of writing an illegal bar.
      const remaining = sixteenthsPerBar - slot;
      let length: number;
      if (note) {
        length = Math.min(note.lengthSixteenths, remaining);
      } else {
        // Group the silence up to the next note (or the barline) into one big rest. Writing
        // sixteen individual sixteenth rests per empty bar made sparse passages render as a
        // wall of rest glyphs that no one can read.
        let span = remaining;
        for (let d = 1; d < remaining; d++) {
          if (byStart.has(absolute + d)) {
            span = d;
            break;
          }
        }
        length = span;
      }
      const clean = nearestCleanAtMost(length);
      const token = SIXTEENTHS_TO_TOKEN[clean];

      if (token !== currentDurationToken) {
        tokens.push(`:${token}`);
        currentDurationToken = token;
      }
      tokens.push(note ? `${note.fret}.${note.string}` : 'r');
      slot += clean;
    }

    bars.push(tokens.join(' '));
  }

  return [
    `\\title "${escapeTex(options.title)}"`,
    // The marking is the whole reason a shuffle can be written in straight eighths. Without
    // it the page is simply wrong — it says even eighths, and nobody plays the song that way.
    ...(options.feel === 'shuffle' ? ['\\subtitle "Shuffle / 셔플 (♪♪ = 3연음)"'] : []),
    `\\tempo ${Math.round(options.bpm)}`,
    '\\instrument 33',
    '.',
    '\\track "Bass"',
    '\\staff{tabs} \\tuning G2 D2 A1 E1',
    '',
    bars.map((b) => `${b} |`).join('\n'),
    '',
  ].join('\n');
}

function nearestCleanAtMost(value: number): number {
  let best = 1;
  for (const candidate of CLEAN_LENGTHS) if (candidate <= value) best = candidate;
  return best;
}

function escapeTex(text: string): string {
  return text.replace(/["\\]/g, '');
}

/* ---------------------------------------------------------------- tempo */

/**
 * Guess a tempo from note onsets.
 *
 * Takes the most common gap between consecutive onsets as one beat-ish unit and folds it into
 * a plausible range. Crude, and wrong often enough that the UI keeps the BPM editable — but a
 * starting number beats making the user guess blind.
 */
export function estimateBpm(notes: DetectedNote[], fallback = 120): number {
  if (notes.length < 4) return fallback;

  const gaps: number[] = [];
  for (let i = 1; i < notes.length; i++) {
    const gap = notes[i].startMs - notes[i - 1].startMs;
    if (gap > 80 && gap < 2000) gaps.push(gap);
  }
  if (gaps.length < 3) return fallback;

  const unit = median(gaps);
  let bpm = 60000 / unit;
  // The common gap is as likely to be an eighth or a sixteenth as a quarter note.
  while (bpm < 60) bpm *= 2;
  while (bpm > 200) bpm /= 2;
  return Math.round(bpm);
}

/* ------------------------------------------------------------- helpers */

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
