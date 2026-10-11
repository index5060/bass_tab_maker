/**
 * Read the bass line off the stem, one grid slot at a time.
 *
 * The first transcriber found notes in continuous time and then tried to snap them to a grid
 * it had guessed. Here the grid comes first (beats.ts), and each slot of it — a sixteenth of
 * a beat — gets two questions:
 *
 *   1. Was a string struck here?   the bass stem's spectral flux (an attack is a burst of
 *                                  energy across the spectrum, a re-plucked note included)
 *   2. What pitch is sounding?     YIN, measured just after the slot starts
 *
 * Asked that way, the timing is right by construction, a repeated note is a second attack
 * rather than a gap that may or may not be wide enough, and quantisation is not a step that
 * can go wrong — the notes are born on the grid.
 */

import { detectPitch, decimate } from '../pitch';
import { bandEnvelope, halfRate, logBandEdges, residualFlux, spectralFlux } from './spectrum';

export interface GridNote {
  /** Absolute slot index: beat * subdivision + position within the beat. */
  startSlot: number;
  /** Exclusive. */
  endSlot: number;
  midi: number;
  /** 0..1, from the pitch detector. */
  confidence: number;
}

export interface DecodedLine {
  notes: GridNote[];
  subdivision: number;
  /** Start time (s) of every slot; slot i lasts until slotTimes[i + 1]. */
  slotTimes: number[];
  /** How far the recording sits from A=440, in cents, already removed from `notes`. */
  tuningCents: number;
  stats: {
    attacks: number;
    slotsWithAttack: number;
    octaveShifted: number;
  };
}

/** Slot start times for a beat list: each beat split into `subdivision` equal parts. */
export function slotTimesFor(beats: number[], subdivision: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < beats.length; k++) {
    const next = k + 1 < beats.length ? beats[k + 1] : beats[k] + (beats[k] - beats[k - 1]);
    const step = (next - beats[k]) / subdivision;
    for (let j = 0; j < subdivision; j++) out.push(beats[k] + j * step);
  }
  return out;
}

/** A string being struck, as the bass stem's spectrum shows it. */
export interface Attack {
  /** Seconds. */
  time: number;
  /**
   * How sharply the spectrum above 150Hz rose: the mean rise per band, in dB. Being a ratio,
   * it does not care how loud the stem is — a pluck reads the same at -30dB as at -3dB.
   */
  strength: number;
}

/** Below this mean rise (dB) a flux peak is noise, not a pluck. */
const ATTACK_FLOOR = 0.1;
/**
 * The flux peak comes slightly before the onset: the analysis window starts to see the pluck
 * before its centre reaches it. Measured with a 46ms window: 4-12ms early.
 */
const ATTACK_LAG = 0.006;

/**
 * Times and strengths of attacks in the bass stem. `band`, the rest of the mix, if given, is
 * what leaked into the stem during separation: rises it explains are not the bass's.
 */
export function bassAttacks(bass: Float32Array, sampleRate: number, band?: Float32Array | null): Attack[] {
  const reduced = sampleRate > 30000 ? halfRate(bass) : bass;
  const rate = sampleRate > 30000 ? sampleRate / 2 : sampleRate;
  // ~46ms windows every 5ms. The window is a trade: a 23ms one holds less than one period of
  // a low E (24ms), so a held low note's level ripples from frame to frame and the ripple
  // reads as attacks — measured over four songs, the strongest such ripple was as strong as
  // the weakest real pluck. At 46ms the weakest pluck stood 2-60 times clear of every ripple
  // for finger and pick bass; at 93ms more still, but the peaks came 20-30ms early, too far
  // for a sixteenth grid.
  const windowSize = 2 ** Math.round(Math.log2(0.046 * rate));
  const hop = Math.round(rate / 200);
  const edges = logBandEdges(30, 5000, 24);
  const env = bandEnvelope(reduced, rate, { windowSize, hopSize: hop, edgesHz: edges });
  // Attacks are judged above 150Hz only: a pluck is broadband, its click and upper harmonics
  // show up there just as clearly, while below it a held note's own beating does too.
  const fromBand = Math.max(0, edges.findIndex((hz) => hz >= 150));
  // Compare with the frame two back (10ms): with this much window overlap, the next frame
  // has barely changed (SuperFlux's rule for the lag gives 2).
  // Against the rest of the mix where it is known, so that what leaked into the stem during
  // separation does not count as plucks (see residualFlux).
  const flux = band
    ? residualFlux(env, bandEnvelope(sampleRate > 30000 ? halfRate(band) : band, rate, { windowSize, hopSize: hop, edgesHz: edges }), { lag: 2, fromBand })
    : spectralFlux(env, { lag: 2, fromBand });

  const peaks: Attack[] = [];
  const near = Math.max(1, Math.round(0.03 / env.hop)); // ±30ms: one attack, one peak
  const before = Math.max(1, Math.round(0.1 / env.hop)); // the 100ms before set the bar to clear
  for (let f = 1; f + 1 < flux.length; f++) {
    const v = flux[f];
    if (v < ATTACK_FLOOR) continue;
    let isMax = true;
    for (let k = Math.max(0, f - near); k <= Math.min(flux.length - 1, f + near); k++) {
      if (flux[k] > v || (flux[k] === v && k < f)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    let mean = 0;
    let count = 0;
    for (let k = Math.max(0, f - before); k < f; k++) {
      mean += flux[k];
      count++;
    }
    mean /= Math.max(1, count);
    if (v < mean + ATTACK_FLOOR) continue;
    peaks.push({ time: f * env.hop + env.offset + ATTACK_LAG, strength: v });
  }

  // One pluck, one attack. A plucked string often throws a second, smaller flux peak 50-150ms
  // into the note (measured: 0.25-0.4 of the attack before it, on finger, pick and fretless
  // sounds). A real re-pluck that fast is a sixteenth at 100 BPM or quicker and comes in at a
  // similar strength to the note it follows — so only a much weaker peak right behind a strong
  // one is dropped.
  const kept: Attack[] = [];
  for (const p of peaks) {
    const previous = kept[kept.length - 1];
    if (previous && p.time - previous.time < 0.15 && p.strength < 0.5 * previous.strength) continue;
    kept.push(p);
  }
  return kept;
}

/** RMS level in dBFS of [from, to) seconds. */
function levelDb(signal: Float32Array, sampleRate: number, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from * sampleRate));
  const b = Math.min(signal.length, Math.max(a + 1, Math.floor(to * sampleRate)));
  let sum = 0;
  for (let i = a; i < b; i++) sum += signal[i] * signal[i];
  return 10 * Math.log10(sum / Math.max(1, b - a) + 1e-12);
}

/** Pitch is read at about 11kHz: everything a bass plays is far below that, and it is 4x cheaper. */
const YIN_RATE = 11025;
/** 58ms: two periods of a low E, short enough for a sixteenth. */
const YIN_SECONDS = 0.058;
/** Measure pitch this long after the slot starts, past the pick's click. */
const PITCH_DELAY = 0.02;
/**
 * The same note struck again (or its octave): its attack must be at least this fraction of a
 * typical pluck on this recording. Measured over four songs and five bass sounds: real
 * re-plucks 0.4-2.6 of typical, everything else that peaks inside a held note (a pluck's own
 * second bump, a synth note's release) 0.02-0.35.
 */
const REPLUCK_RATIO = 0.3;
/** ...and the level must not be falling away: a note being released drops 10-16dB right there. */
const REPLUCK_FALL = -3;
/** A clear rise in level (dB, 50ms either side) is a re-pluck however soft its attack. */
const REPLUCK_RISE = 3;

/** What the decoder saw in one slot — for diagnosing a wrong tab, not for normal use. */
export interface SlotTrace {
  slot: number;
  time: number;
  levelDb: number;
  attack: number;
  /** Level change across the attack (dB), when there is one. */
  rise: number;
  /** What a pluck typically measures on this recording. */
  typical: number;
  midi: number;
  confidence: number;
  decision: 'silent' | 'start' | 'continue';
  reason: string;
}

export function decodeBassLine(
  bass: Float32Array,
  sampleRate: number,
  beats: number[],
  options: { subdivision?: number; band?: Float32Array | null; trace?: (slot: SlotTrace) => void } = {},
): DecodedLine {
  const subdivision = options.subdivision ?? 4;
  const slotTimes = slotTimesFor(beats, subdivision);
  const slots = slotTimes.length;
  const slotEnd = (i: number) => (i + 1 < slots ? slotTimes[i + 1] : slotTimes[i] + (slotTimes[i] - slotTimes[i - 1]));

  // 1. Attacks, each given to the nearest slot, with how the level moved across it.
  const divisor = Math.max(1, Math.round(sampleRate / YIN_RATE));
  const yinRate = sampleRate / divisor;
  const low = decimate(bass, divisor);
  const yinWindow = Math.round(YIN_SECONDS * yinRate);
  const attacks = bassAttacks(bass, sampleRate, options.band);
  const attackAt = new Float64Array(slots);
  const riseAt = new Float64Array(slots);
  let slot = 0;
  for (const a of attacks) {
    while (slot + 1 < slots && Math.abs(slotTimes[slot + 1] - a.time) <= Math.abs(slotTimes[slot] - a.time)) slot++;
    if (a.strength > attackAt[slot]) {
      attackAt[slot] = a.strength;
      // 50ms is two periods of a low E: long enough that the level does not ripple with the
      // waveform, short enough to stay inside a sixteenth.
      riseAt[slot] = levelDb(low, yinRate, a.time + 0.005, a.time + 0.055) - levelDb(low, yinRate, a.time - 0.055, a.time - 0.005);
    }
  }

  // 2. Level and pitch per slot.
  const levels = new Float64Array(slots);
  for (let i = 0; i < slots; i++) levels[i] = levelDb(bass, sampleRate, slotTimes[i], slotEnd(i));
  const sortedLevels = Array.from(levels).sort((a, b) => a - b);
  const loud = sortedLevels[Math.floor(sortedLevels.length * 0.9)];
  // Silence: far under the loud slots, and under an absolute floor for bleed and hiss.
  const silence = Math.max(loud - 30, -70);
  // ...and, when the rest of the mix is known, no louder than what leaks from it. While the
  // bass rests, its stem still carries the band some dB down (measured with a 20dB leak: the
  // guitar's intro read as a bass line). Leakage is a scaled copy of the band, so over those
  // stretches (stem − band) holds one value: a tight cluster at the low end of its range. A
  // bass note dying away drifts through that range instead, so without such a cluster — or
  // with one close to where the bass normally plays — nothing is cut.
  const leakOnly = new Uint8Array(slots);
  if (options.band) {
    const bandLevels = new Float64Array(slots);
    for (let i = 0; i < slots; i++) bandLevels[i] = levelDb(options.band, sampleRate, slotTimes[i], slotEnd(i));
    const bandLoud = Math.max(...bandLevels);
    const differences: number[] = [];
    for (let i = 0; i < slots; i++) if (bandLevels[i] > bandLoud - 40 && levels[i] > -100) differences.push(levels[i] - bandLevels[i]);
    differences.sort((a, b) => a - b);
    if (differences.length >= 20) {
      const leak = differences[Math.floor(differences.length * 0.05)];
      const usual = differences[differences.length >> 1];
      const cluster = differences.filter((d) => Math.abs(d - leak) <= 2).length / differences.length;
      // ...and leakage is quieter than its source: a "floor" level with the band is not one.
      if (cluster >= 0.1 && leak < -6 && leak + 6 < usual - 10) {
        for (let i = 0; i < slots; i++) if (levels[i] < bandLevels[i] + leak + 6) leakOnly[i] = 1;
      }
    }
  }
  const isSilent = (i: number) => levels[i] < silence || leakOnly[i] === 1;

  const pitchHz = new Float64Array(slots);
  const pitchConfidence = new Float64Array(slots);
  for (let i = 0; i < slots; i++) {
    if (isSilent(i)) continue;
    const start = Math.floor((slotTimes[i] + PITCH_DELAY) * yinRate);
    if (start < 0 || start + yinWindow > low.length) continue;
    const result = detectPitch(low.subarray(start, start + yinWindow), { sampleRate: yinRate, minHz: 35, maxHz: 500 });
    pitchHz[i] = result.hz;
    pitchConfidence[i] = result.confidence;
  }

  // 3. The recording's own tuning: how far its confident pitches sit from the semitone grid.
  //    Circular mean, so a recording 45 cents sharp and one 55 cents flat both come out right.
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < slots; i++) {
    if (pitchConfidence[i] < 0.85 || pitchHz[i] <= 0) continue;
    const midi = 69 + 12 * Math.log2(pitchHz[i] / 440);
    const angle = 2 * Math.PI * (midi - Math.round(midi));
    sx += Math.cos(angle);
    sy += Math.sin(angle);
  }
  const tuningCents = sx || sy ? (Math.atan2(sy, sx) / (2 * Math.PI)) * 100 : 0;
  const slotMidi = (i: number) =>
    pitchHz[i] > 0 ? Math.round(69 + 12 * Math.log2(pitchHz[i] / 440) - tuningCents / 100) : -1;
  const confident = (i: number) => i >= 0 && pitchConfidence[i] >= 0.6 && slotMidi(i) > 0;

  // The pitch an attack leads into: the slot's own reading, or — when the pluck's click
  // spoils that one (slap, pick) — the next slot's, if nothing is struck there.
  const pitchAfter = (i: number) =>
    confident(i) ? slotMidi(i) : i + 1 < slots && attackAt[i + 1] <= 0 && confident(i + 1) ? slotMidi(i + 1) : -1;

  // 4. What a pluck looks like on this recording. Attack strength depends on the sound — a
  //    finger-style note jumps 2-30dB above 150Hz, a pick or fretless one often under 1dB
  //    (measured) — so "strong" can only mean strong for this bass. Where the pitch changes
  //    across an attack while the previous note still sounds, it is a new note for certain;
  //    those attacks set the yardstick. (Attacks out of silence are left out: from nothing,
  //    every band jumps by tens of dB, which says nothing about a pluck into a ringing note.)
  const changes: number[] = [];
  const legato: number[] = [];
  for (let i = 1; i < slots; i++) {
    if (attackAt[i] <= 0 || isSilent(i - 1)) continue;
    legato.push(attackAt[i]);
    const after = pitchAfter(i);
    if (!confident(i - 1) || after < 0) continue;
    const step = Math.abs(after - slotMidi(i - 1));
    if (step !== 0 && step % 12 !== 0) changes.push(attackAt[i]);
  }
  const all = Array.from(attackAt).filter((v) => v > 0);
  const typical = median(changes.length >= 4 ? changes : legato.length >= 4 ? legato : all.length ? all : [1]);

  // 5. Walk the slots: sound after silence starts a note, silence ends one; an attack starts
  //    one when the pitch changes, or — for the same pitch struck again — when the level rises
  //    with it; a clear, held change of pitch without an attack (a hammer-on, a slide's
  //    arrival) starts one too.
  const notes: Array<GridNote & { pitches: number[] }> = [];
  let current: (GridNote & { pitches: number[] }) | null = null;
  const close = (at: number) => {
    if (current) {
      current.endSlot = at;
      notes.push(current);
      current = null;
    }
  };
  for (let i = 0; i < slots; i++) {
    const trace = (decision: SlotTrace['decision'], reason: string) =>
      options.trace?.({ slot: i, time: slotTimes[i], levelDb: levels[i], attack: attackAt[i], rise: riseAt[i], typical, midi: slotMidi(i), confidence: pitchConfidence[i], decision, reason });
    if (isSilent(i)) {
      close(i);
      trace('silent', leakOnly[i] ? 'leak' : '');
      continue;
    }
    const midi = attackAt[i] > 0 ? pitchAfter(i) : slotMidi(i);
    const sure = attackAt[i] > 0 ? midi > 0 : confident(i);
    const held = current && current.pitches.length ? median(current.pitches) : -1;
    // An exact octave move is not trusted on its own: YIN reads an octave low for a moment
    // right after a pluck (measured: Db2 read as Db1 once, 20ms in) — and that slip had been
    // splitting the note in two. A slip lasts one reading; an octave played on purpose is
    // struck, and still reads as the new octave a slot later.
    const interval = Math.abs(midi - held);
    const pitchMoved = sure && held > 0 && interval !== 0 && interval % 12 !== 0;
    const octaveMoved =
      sure && held > 0 && interval !== 0 && interval % 12 === 0 && i + 1 < slots && confident(i + 1) && slotMidi(i + 1) === midi;
    let starts = false;
    let reason = '';
    if (current === null) {
      starts = true;
      reason = 'after-silence';
    } else if (attackAt[i] > 0 && (pitchMoved || octaveMoved || held <= 0)) {
      starts = true;
      reason = pitchMoved || octaveMoved ? `attack, pitch ${held}->${midi}` : 'attack';
    } else if (attackAt[i] > 0) {
      // The same note again — or something that only looks like an attack inside a held note:
      // a second bump in one pluck's decay, a synth note's release. Those are far weaker than
      // a pluck, and a release is the level falling away.
      const ratio = attackAt[i] / typical;
      if ((ratio >= REPLUCK_RATIO && riseAt[i] >= REPLUCK_FALL) || riseAt[i] >= REPLUCK_RISE) {
        starts = true;
        reason = `repluck ${ratio.toFixed(2)} rise ${riseAt[i].toFixed(1)}dB`;
      }
    }
    if (!starts && pitchMoved) {
      // No attack, but a clear change of pitch that holds: a hammer-on or the end of a slide.
      const nextSame = i + 1 < slots && slotMidi(i + 1) === midi && confident(i + 1);
      if (nextSame) {
        starts = true;
        reason = `pitch ${held}->${midi}`;
      }
    }
    trace(starts ? 'start' : 'continue', reason);
    if (starts) {
      close(i);
      current = { startSlot: i, endSlot: i + 1, midi: -1, confidence: 0, pitches: [] };
    }
    // A note's pitch is what it sounds like over its first two slots: later ones are decay,
    // and decay is where the octave slips happen.
    if (current && confident(i) && i - current.startSlot < 2) {
      current.pitches.push(slotMidi(i));
      current.confidence = Math.max(current.confidence, pitchConfidence[i]);
    }
  }
  close(slots);

  // 6. Pitch per note; notes with no readable pitch at all are dropped rather than guessed.
  let octaveShifted = 0;
  const out: GridNote[] = [];
  for (const n of notes) {
    if (!n.pitches.length) continue;
    let midi = median(n.pitches);
    // A standard-tuned 4-string bass goes from E1 (28) to about G4 (67). Below that it is a
    // detector slip an octave down, above it most likely a harmonic.
    while (midi < 28) {
      midi += 12;
      octaveShifted++;
    }
    while (midi > 67) {
      midi -= 12;
      octaveShifted++;
    }
    out.push({ startSlot: n.startSlot, endSlot: n.endSlot, midi, confidence: n.confidence });
  }

  return {
    notes: out,
    subdivision,
    slotTimes,
    tuningCents,
    stats: {
      attacks: attacks.length,
      slotsWithAttack: Array.from(attackAt).filter((v) => v > 0).length,
      octaveShifted,
    },
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}
