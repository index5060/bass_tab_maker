/**
 * Which string and fret each note is played on.
 *
 * A pitch can usually be played in two or three places on a bass, and which one is right
 * depends on what comes before and after it — the hand has to get there. The first version
 * looked only at the previous note and took whatever was nearest, which scattered a simple
 * root-note line across all four strings (measured on Holiday: 51% of positions agreed with
 * the published tab).
 *
 * This chooses for the whole line at once (Viterbi), with a model of the fretting hand:
 * the index finger sits at a position and the hand covers four frets from there, one more
 * with a stretch. Costs follow how bass is taught and played:
 *   - moving the hand to a new position costs the most — except while an open string is
 *     ringing, when the fretting hand is free and the shift is nearly free (the classic way
 *     a line gets from the 8th fret to the 4th);
 *   - changing string costs something too: a root-note line slides along one string rather
 *     than hopping across all four;
 *   - for the same pitch, a lower string and a lower fret are preferred, gently;
 *   - a repeated note stays where it was.
 * Checked against the published Holiday tab, where Mike Dirnt plays F-Db-Ab-Eb as A8, A4, E4,
 * A6 with open strings between: hopping across strings to stay in one position scored 55%
 * agreement, these costs reproduce his choices.
 */

import type { GridNote } from './notes';

export interface FrettedNote extends GridNote {
  /** alphaTex numbering: 1 is the highest string (G on a 4-string), 4 the lowest (E). */
  string: number;
  fret: number;
}

/** Standard 4-string tuning, lowest string first: E1 A1 D2 G2. */
export const BASS_TUNING = [28, 33, 38, 43];
const MAX_FRET = 20;
const MAX_HAND = 17;

interface State {
  stringIndex: number;
  fret: number;
  /** Fret under the index finger. */
  hand: number;
  cost: number;
}

function candidates(midi: number, tuning: number[]): State[] {
  const out: State[] = [];
  for (let s = 0; s < tuning.length; s++) {
    const fret = midi - tuning[s];
    if (fret < 0 || fret > MAX_FRET) continue;
    // Lower strings and lower frets preferred, gently: tie-breakers, not rules. Low-register
    // notes (under C3) are kept off the D and G strings: that is where published tabs and
    // players put roots, for the fuller sound of the thick strings.
    const unary = 0.15 * s + 0.05 * fret + (midi < 48 && s >= 2 ? 0.3 : 0);
    if (fret === 0) {
      // An open string does not care where the hand is: it can stay wherever it was.
      for (let hand = 1; hand <= MAX_HAND; hand++) out.push({ stringIndex: s, fret, hand, cost: unary });
      continue;
    }
    // Index finger anywhere from four frets below (pinky stretch) to one above (index
    // stretch back); frets h..h+3 are the comfortable span.
    for (let hand = Math.max(1, fret - 4); hand <= Math.min(MAX_HAND, fret + 1); hand++) {
      const stretch = fret - hand === 4 || fret - hand === -1 ? 0.3 : 0;
      out.push({ stringIndex: s, fret, hand, cost: unary + stretch });
    }
  }
  return out;
}

function transition(from: State, to: State, interval: number): number {
  const shift = Math.abs(to.hand - from.hand);
  let cost = shift > 0 ? 1 + 0.3 * shift : 0;
  // The hand is free while an open string rings: that is when shifts happen.
  if (from.fret === 0) cost *= 0.25;
  const strings = to.stringIndex - from.stringIndex;
  cost += 0.4 * Math.abs(strings);
  if (interval === 0 && (strings !== 0 || to.fret !== from.fret)) cost += 2;
  // The octave shape — two strings over, two frets up — is how an octave is played on a bass
  // (the funk "octave pop"), low register or not.
  if (Math.abs(interval) === 12 && strings === 2 * Math.sign(interval) && to.fret - from.fret === 2 * Math.sign(interval)) cost -= 1;
  return cost;
}

export function assignFrets(notes: GridNote[], tuning: number[] = BASS_TUNING): FrettedNote[] {
  const playable = notes.filter((n) => candidates(n.midi, tuning).length > 0);
  if (playable.length === 0) return [];

  const layers = playable.map((n) => candidates(n.midi, tuning));
  const total: number[][] = [layers[0].map((s) => s.cost)];
  const back: number[][] = [layers[0].map(() => -1)];
  for (let i = 1; i < layers.length; i++) {
    const interval = playable[i].midi - playable[i - 1].midi;
    const row: number[] = [];
    const links: number[] = [];
    for (const state of layers[i]) {
      let best = Infinity;
      let bestFrom = 0;
      for (let p = 0; p < layers[i - 1].length; p++) {
        const c = total[i - 1][p] + transition(layers[i - 1][p], state, interval);
        if (c < best) {
          best = c;
          bestFrom = p;
        }
      }
      row.push(best + state.cost);
      links.push(bestFrom);
    }
    total.push(row);
    back.push(links);
  }

  let at = 0;
  const last = total[total.length - 1];
  for (let s = 1; s < last.length; s++) if (last[s] < last[at]) at = s;
  const chosen: State[] = new Array(layers.length);
  for (let i = layers.length - 1; i >= 0; i--) {
    chosen[i] = layers[i][at];
    at = back[i][at];
  }
  return playable.map((n, i) => ({
    ...n,
    string: tuning.length - chosen[i].stringIndex,
    fret: chosen[i].fret,
  }));
}
