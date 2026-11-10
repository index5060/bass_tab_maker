/**
 * Straight or triplet: how each beat is divided.
 *
 * The note decoder reads the bass on a grid of slots per beat, and a grid that does not have a
 * note's place cannot write it there: a shuffle's triplet eighths on a sixteenth grid land a
 * twelfth of a beat off and come out as dotted rhythms (measured: Slakh Track00001, a song in
 * triplets, 46% of its notes right, nearly all the rest one slot off). So each beat gets the
 * division its attacks fit: four (sixteenths) or three (triplet eighths).
 *
 * The evidence is where the bass's attacks fall inside the beat. An attack on the beat says
 * nothing (both grids have it); one halfway says straight; one a third or two thirds in says
 * triplet. Per beat that is noisy — a pushed note, a beat with no off-beat note at all — so
 * the choice is smoothed over the song: changing feel costs, staying is free, and a beat
 * without evidence keeps the feel around it.
 */

/** Slots per beat: 4 for straight sixteenths, 3 for triplet eighths. */
export type BeatDivision = 3 | 4;

/** How precisely an attack time is known (s): the attack picker's spread, measured 4-12ms. */
const TIMING_SPREAD = 0.015;
/** The most one attack can say either way (log-odds): one odd note does not decide a beat. */
const MOST_PER_ATTACK = 3;
/**
 * Attacks under this fraction of a strong one (the recording's 75th percentile) are not
 * counted. Measured on Slakh: a straight song's quarter notes, with bumps at 0.1-2.4 against
 * plucks at 10-19, had 113 beats read as triplet with every attack counted, none from 0.2 on;
 * and the triplets found went from 204 of 254 to 238.
 */
const WEAK = 0.2;
/** Cost (log-odds) of switching between straight and triplet. */
const SWITCH = 4;
/**
 * Straight is the default: a beat needs at least this much evidence to be read as triplet.
 * SWITCH, TIMING_SPREAD and this were swept together on Slakh's 19 songs (a flat best region);
 * with WEAK, 238 of 254 notes on triplet places end up in beats read as triplet, 4 of 3,798
 * on straight places do.
 */
const STRAIGHT_PRIOR = 0.1;

/** Distance from `phase` (0..1 of a beat) to the nearest multiple of 1/`division`. */
function offGrid(phase: number, division: number): number {
  const scaled = phase * division;
  return Math.abs(scaled - Math.round(scaled)) / division;
}

/**
 * The division of every beat, from the attacks of the bass (time in s, strength as
 * bassAttacks measures it). `beats` are the beat times; the last beat is taken to last as long
 * as the one before it.
 */
export function chooseDivisions(
  beats: number[],
  attacks: Array<{ time: number; strength: number }>,
  trace?: (beat: number, evidence: number) => void,
): BeatDivision[] {
  const n = beats.length;
  if (n < 2) return Array.from({ length: n }, () => 4);
  const lengthOf = (b: number) => (b + 1 < n ? beats[b + 1] - beats[b] : beats[b] - beats[b - 1]);
  const beatOf = (t: number) => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // Attacks far weaker than the recording's plucks are left out: the bumps inside a held
  // note land wherever its decay puts them, often a third of a beat on.
  const byStrength = attacks.map((a) => a.strength).sort((x, y) => x - y);
  const strong = byStrength.length ? byStrength[Math.floor(byStrength.length * 0.75)] : 0;
  const sorted = attacks.filter((a) => a.strength >= WEAK * strong).sort((x, y) => x.time - y.time);

  // How late this recording's attacks come against its beats: the attack picker's window sees
  // a soft-edged pluck late (measured: Slakh Track00001, 20-45ms) — enough, at 80 BPM, to move
  // a note two thirds into the beat nearer three quarters. Taken from attacks right by a beat.
  const offsets: number[] = [];
  for (const { time } of sorted) {
    const b = beatOf(time);
    for (const k of [b, b + 1]) {
      if (k >= n) continue;
      const d = time - beats[k];
      if (Math.abs(d) <= Math.min(0.06, lengthOf(Math.min(k, n - 1)) / 8)) offsets.push(d);
    }
  }
  offsets.sort((x, y) => x - y);
  const lag = offsets.length >= 20 ? offsets[offsets.length >> 1] : 0;

  // Log-odds per beat that it is triplet rather than straight, from where each attack sits in
  // its beat, late attacks moved back by the lag. (How far apart attacks are, which no lag
  // changes, was tried too: on Slakh it caught fewer triplets and put 103 straight notes in
  // triplet beats — the gaps between the weak attacks among the plucks are noise.)
  const evidence = new Float64Array(n);
  for (const { time } of sorted) {
    const t = time - lag;
    if (t < beats[0]) continue;
    const b = beatOf(t);
    const length = lengthOf(b);
    const phase = (t - beats[b]) / length;
    if (phase >= 1) continue;
    const straight = offGrid(phase, 4) * length;
    const triplet = offGrid(phase, 3) * length;
    const odds = (straight * straight - triplet * triplet) / (2 * TIMING_SPREAD * TIMING_SPREAD);
    evidence[b] += Math.max(-MOST_PER_ATTACK, Math.min(MOST_PER_ATTACK, odds));
  }

  if (trace) for (let i = 0; i < n; i++) trace(i, evidence[i]);
  // Viterbi over two states, straight (0) and triplet (1).
  const back = new Uint8Array(n * 2);
  let straightScore = 0;
  let tripletScore = -SWITCH;
  for (let i = 0; i < n; i++) {
    const tripletGain = evidence[i] - STRAIGHT_PRIOR;
    const fromStraightToS = straightScore;
    const fromTripletToS = tripletScore - SWITCH;
    const fromTripletToT = tripletScore;
    const fromStraightToT = straightScore - SWITCH;
    const s = Math.max(fromStraightToS, fromTripletToS);
    back[i * 2] = fromStraightToS >= fromTripletToS ? 0 : 1;
    const t = Math.max(fromTripletToT, fromStraightToT) + tripletGain;
    back[i * 2 + 1] = fromTripletToT >= fromStraightToT ? 1 : 0;
    straightScore = s;
    tripletScore = t;
  }
  const out: BeatDivision[] = new Array(n);
  let state = straightScore >= tripletScore ? 0 : 1;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = state === 1 ? 3 : 4;
    state = back[i * 2 + state];
  }
  return out;
}
