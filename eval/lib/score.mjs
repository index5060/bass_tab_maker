/**
 * Score a generated tab against the correct one.
 *
 * Both sides are alphaTex, parsed by alphaTab itself, so the comparison is about the music
 * the tab says — bar, position in the bar, pitch, string and fret — not about how the text
 * happens to be laid out.
 *
 * Besides the scores, it looks for the single shift (whole bars, and sixteenths within the
 * bar) that would make the generated tab line up best. A tab whose notes are right but sit one
 * sixteenth late everywhere scores near zero, yet the problem is one number, not hundreds of
 * wrong notes — and that is exactly the difference between "the grid is misplaced" and "the
 * transcription is wrong", which no single score shows.
 */
import { parseTex } from './render.mjs';

const TICKS_PER_QUARTER = 960;
const SIXTEENTH = TICKS_PER_QUARTER / 4;

/** Ticks in one bar of the score's first time signature. */
export function barTicks(tex) {
  const { score } = parseTex(tex);
  const mb = score.masterBars[0];
  return (mb.timeSignatureNumerator * 4 * TICKS_PER_QUARTER) / mb.timeSignatureDenominator;
}

/** Every struck bass note: absolute tick, bar, pitch and where it is played. */
export function bassNotes(tex) {
  const { score } = parseTex(tex);
  const track = score.tracks.find((t) => /bass/i.test(t.name) && !t.isPercussion) ?? score.tracks.find((t) => !t.isPercussion);
  if (!track) return [];
  const staff = track.staves[0];
  const strings = staff.tuning.length;
  const notes = [];
  for (const bar of staff.bars) {
    const master = score.masterBars[bar.index];
    for (const beat of bar.voices[0].beats) {
      if (beat.isRest) continue;
      for (const n of beat.notes) {
        // A tied note continues the one before it; it is not a new pluck.
        if (n.isTieDestination) continue;
        notes.push({
          tick: master.start + beat.playbackStart,
          bar: bar.index,
          midi: n.realValue,
          // alphaTex numbers strings from the top (1 = G); the model counts from the bottom.
          string: strings - n.string + 1,
          fret: n.fret,
        });
      }
    }
  }
  return notes.sort((a, b) => a.tick - b.tick);
}

/** Greedy one-to-one matching in time order, within `tolerance` ticks. */
function match(pred, truth, tolerance, samePitch) {
  const used = new Set();
  const pairs = [];
  for (const t of truth) {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < pred.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(pred[i].tick - t.tick);
      if (d > tolerance || (samePitch && pred[i].midi !== t.midi)) continue;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    if (best >= 0) {
      used.add(best);
      pairs.push([pred[best], t]);
    }
  }
  return pairs;
}

function f1(pairs, predCount, truthCount) {
  const precision = predCount ? pairs / predCount : 0;
  const recall = truthCount ? pairs / truthCount : 0;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

/**
 * @param {string} predictedTex
 * @param {string} truthTex
 */
export function scoreTab(predictedTex, truthTex) {
  const truth = bassNotes(truthTex);
  const predAll = bassNotes(predictedTex);
  const lastTick = Math.max(...truth.map((n) => n.tick)) + 4 * TICKS_PER_QUARTER;
  // Only the span the truth covers is judged; anything the tab writes after it is not wrong.
  const pred = predAll.filter((n) => n.tick < lastTick);

  const strictPairs = match(pred, truth, SIXTEENTH / 2, true);
  const loosePairs = match(pred, truth, SIXTEENTH, true);
  const onsetPairs = match(pred, truth, SIXTEENTH / 2, false);

  // Which global shift would have lined everything up? Bars and sixteenths, searched together
  // (sixteenths up to half a bar either way, so every offset is reachable).
  const bar = barTicks(truthTex);
  const halfBar = Math.ceil(bar / SIXTEENTH / 2);
  let bestShift = { bars: 0, sixteenths: 0, f1: f1(strictPairs.length, pred.length, truth.length).f1 };
  for (let bars = -2; bars <= 2; bars++) {
    for (let sixteenths = -halfBar; sixteenths <= halfBar; sixteenths++) {
      if (bars === 0 && sixteenths === 0) continue;
      const offset = bars * bar + sixteenths * SIXTEENTH;
      const shifted = pred.map((n) => ({ ...n, tick: n.tick + offset }));
      const score = f1(match(shifted, truth, SIXTEENTH / 2, true).length, pred.length, truth.length).f1;
      if (score > bestShift.f1 + 1e-9) bestShift = { bars, sixteenths, f1: score };
    }
  }

  const sameFret = strictPairs.filter(([p, t]) => p.string === t.string && p.fret === t.fret).length;
  const octaveOff = onsetPairs.filter(([p, t]) => p.midi !== t.midi && (p.midi - t.midi) % 12 === 0).length;
  const otherPitch = onsetPairs.filter(([p, t]) => p.midi !== t.midi && (p.midi - t.midi) % 12 !== 0).length;

  return {
    truthNotes: truth.length,
    predictedNotes: pred.length,
    strict: f1(strictPairs.length, pred.length, truth.length),
    loose: f1(loosePairs.length, pred.length, truth.length),
    onsetOnly: f1(onsetPairs.length, pred.length, truth.length),
    /** Of the notes found at the right place with the right pitch, how many on the right string and fret. */
    fretAgreement: strictPairs.length ? sameFret / strictPairs.length : 0,
    octaveErrors: octaveOff,
    wrongPitch: otherPitch,
    bestShift,
  };
}

/** One line per bar: what the truth has and what was written, for reading a failure. */
export function barDiff(predictedTex, truthTex, bars) {
  const truth = bassNotes(truthTex);
  const pred = bassNotes(predictedTex);
  const size = barTicks(truthTex);
  const show = (list, bar) =>
    list
      .filter((n) => n.bar === bar)
      .map((n) => `${Math.round(((n.tick % size) / SIXTEENTH) * 100) / 100}:${n.fret}.${n.string}`)
      .join(' ');
  return bars.map((bar) => `  ${String(bar + 1).padStart(3)} 정답 ${show(truth, bar).padEnd(44)} | 생성 ${show(pred, bar)}`);
}
