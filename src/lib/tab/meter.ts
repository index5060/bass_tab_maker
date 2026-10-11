/**
 * Which beat is "one", and how many beats make a bar.
 *
 * The first transcriber never asked: it started bar 1 at 0:00 of the file. Real files start
 * with silence, a count-in or a pickup, so every bar line landed somewhere inside a bar —
 * measured on Holiday with 237ms of silence in front: every note three sixteenths off, the
 * tab a page of syncopated nonsense while the notes themselves were fine.
 *
 * Three kinds of evidence, which answer different parts of the question:
 *   - drums: the snare lands on 2 and 4, the kick on 1 and 3. That separates {1,3} from
 *     {2,4} — and where the kick plays 1 but not 3, as it often does, 1 from 3 too.
 *   - bass: the bass changes note where the harmony changes, and the harmony changes most on
 *     the downbeat. That tells 1 from 3 when the drums cannot.
 *   - the start: a band starts on "one" far more often than anywhere else. Worth little on
 *     its own, but it settles a tie (measured: a funk groove whose bass changes note on every
 *     beat, with the kick on 1 only, came out half a bar off with the first two alone).
 */

import type { OnsetStrength } from './beats';
import type { GridNote } from './notes';

export interface Meter {
  beatsPerBar: number;
  /** Index (into the beat list) of a downbeat; every beatsPerBar-th beat from it is one. */
  downbeatPhase: number;
  /** How clearly the chosen phase beat the others, 0..1. Low means "a guess". */
  confidence: number;
  /** Every reading considered, for diagnosing a wrong bar line. */
  candidates: Array<{ beatsPerBar: number; phase: number; drum: number; bass: number; score: number }>;
}

/** Strongest value of `curve` within ±30ms of `time`. */
export function peakNear(curve: Float32Array, hop: number, offset: number, time: number): number {
  const centre = Math.round((time - offset) / hop);
  const reach = Math.max(1, Math.round(0.03 / hop));
  let best = 0;
  for (let i = centre - reach; i <= centre + reach; i++) if (i >= 0 && i < curve.length && curve[i] > best) best = curve[i];
  return best;
}

function zScores(values: number[]): number[] {
  const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, values.length)) || 1;
  return values.map((v) => (v - mean) / sd);
}

/** Mean of `values` over the indices congruent to `phase` modulo `period`. */
function phaseMean(values: number[], period: number, phase: number, use: boolean[]): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (!use[i] || ((i - phase) % period + period) % period !== 0) continue;
    sum += values[i];
    count++;
  }
  return count ? sum / count : 0;
}

/** Kick and snare strength at each beat, in units of their own spread (z-scores). */
export function drumHits(beats: number[], drums: OnsetStrength): { kick: number[]; snare: number[] } {
  return {
    kick: zScores(beats.map((t) => peakNear(drums.low, drums.hop, drums.offset, t))),
    snare: zScores(beats.map((t) => peakNear(drums.high, drums.hop, drums.offset, t))),
  };
}

/**
 * How well the drums fit each bar reading: for 4/4 and 3/4, and each beat as "one", how much
 * the kick and snare fall where those metres put them — over the beats `use` marks.
 */
export function drumPattern(
  hits: { kick: number[]; snare: number[] },
  use: boolean[],
): Array<{ beatsPerBar: number; phase: number; drum: number }> {
  const k = (period: number, phase: number) => phaseMean(hits.kick, period, phase, use);
  const s = (period: number, phase: number) => phaseMean(hits.snare, period, phase, use);
  const out: Array<{ beatsPerBar: number; phase: number; drum: number }> = [];
  for (let phase = 0; phase < 4; phase++) {
    // Snare on 2 and 4, kick on 1 and 3 — and the kick on 1 more than on 3.
    const drum =
      s(4, phase + 1) + s(4, phase + 3) - s(4, phase) - s(4, phase + 2) +
      k(4, phase) + k(4, phase + 2) - k(4, phase + 1) - k(4, phase + 3) +
      (k(4, phase) - k(4, phase + 2));
    out.push({ beatsPerBar: 4, phase, drum });
  }
  for (let phase = 0; phase < 3; phase++) {
    // Kick on 1, snare (or nothing) on 2 and 3.
    const drum =
      k(3, phase) - 0.5 * (k(3, phase + 1) + k(3, phase + 2)) +
      0.5 * (s(3, phase + 1) + s(3, phase + 2)) - s(3, phase);
    out.push({ beatsPerBar: 3, phase, drum });
  }
  return out;
}

export function findMeter(
  beats: number[],
  notes: GridNote[],
  subdivision: number,
  drums: OnsetStrength | null,
  tracked: { first: number; last: number },
): Meter {
  const count = beats.length;
  // Bass evidence per beat: a note starts on it, and it is a different note from the last one.
  const starts = new Array(count).fill(0);
  const changes = new Array(count).fill(0);
  const sorted = [...notes].sort((a, b) => a.startSlot - b.startSlot);
  let previousMidi = -1;
  for (const n of sorted) {
    if (n.startSlot % subdivision === 0) {
      const beat = n.startSlot / subdivision;
      if (beat < count) {
        starts[beat] = 1;
        if (n.midi !== previousMidi) changes[beat] = 1;
      }
    }
    previousMidi = n.midi;
  }
  // Only beats the bass actually plays over say anything about the harmony.
  const bassFirst = sorted.length ? Math.floor(sorted[0].startSlot / subdivision) : count;
  const bassLast = sorted.length ? Math.floor(sorted[sorted.length - 1].startSlot / subdivision) : -1;
  const useBass = beats.map((_, i) => i >= bassFirst && i <= bassLast);
  const drumFit = drums
    ? drumPattern(drumHits(beats, drums), beats.map((_, i) => i >= tracked.first && i <= tracked.last))
    : [];

  const candidates: Meter['candidates'] = [];
  for (const period of [4, 3]) {
    const bassMeans: number[] = [];
    for (let phase = 0; phase < period; phase++) {
      bassMeans.push(2 * phaseMean(changes, period, phase, useBass) + phaseMean(starts, period, phase, useBass));
    }
    const bassAverage = bassMeans.reduce((s, v) => s + v, 0) / period;
    for (let phase = 0; phase < period; phase++) {
      const drum = drumFit.find((d) => d.beatsPerBar === period && d.phase === phase)?.drum ?? 0;
      const bass = bassMeans[phase] - bassAverage;
      const start = ((tracked.first - phase) % period + period) % period === 0 ? 0.3 : 0;
      candidates.push({ beatsPerBar: period, phase, drum, bass, score: 0.5 * drum + bass + start });
    }
  }

  // 3/4 has to win clearly: most of what this app will meet is in 4, and a waltz shows
  // itself plainly in both the drums and the bass.
  const best4 = candidates.filter((c) => c.beatsPerBar === 4).sort((a, b) => b.score - a.score);
  const best3 = candidates.filter((c) => c.beatsPerBar === 3).sort((a, b) => b.score - a.score);
  const chosen = best3[0].score > 1.5 * best4[0].score && best3[0].score > 0.5 ? best3 : best4;
  const margin = chosen[0].score - (chosen[1]?.score ?? 0);
  return {
    beatsPerBar: chosen[0].beatsPerBar,
    downbeatPhase: chosen[0].phase,
    confidence: Math.max(0, Math.min(1, margin / (Math.abs(chosen[0].score) + 1e-9))),
    candidates,
  };
}
