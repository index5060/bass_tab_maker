/**
 * Where the beats are, from the band rather than from the bass.
 *
 * The first transcriber guessed the beat from the bass notes alone. A bass line is a poor
 * clock — it rests, it syncopates, it holds notes across beats — while the drums state the
 * beat outright on every one of them. So the beat comes from the accompaniment (or the full
 * mix), and the bass is read against it afterwards.
 *
 * And it is a list of beat times, not one tempo. A single tempo for a whole song drifts off
 * any recording made without a click, and even with a click a 0.1% error in that one number
 * puts the grid two sixteenths off by the end of a four-minute song. Tracking each beat
 * removes both problems at once.
 *
 * Method: onset strength (spectral flux) -> global tempo from its autocorrelation with a
 * prior around 120 BPM -> dynamic-programming beat tracking (Ellis, "Beat Tracking by Dynamic
 * Programming", JNMR 2007 — the algorithm behind librosa.beat.beat_track).
 */

import { bandEnvelope, halfRate, logBandEdges, spectralFlux } from './spectrum';

export interface OnsetStrength {
  /** One value per frame; peaks where something is struck. */
  envelope: Float32Array;
  /** Seconds per frame. */
  hop: number;
  /** Time of frame 0. */
  offset: number;
  /** The same, restricted to the kick-drum register (<150Hz) and to the snare/hat register. */
  low: Float32Array;
  high: Float32Array;
}

/** Onset strength of a band recording, at ~100 frames per second. */
export function onsetStrength(signal: Float32Array, sampleRate: number): OnsetStrength {
  // Analysis at half rate: attacks are just as visible at 22kHz and it halves the work.
  const reduced = sampleRate > 30000 ? halfRate(signal) : signal;
  const rate = sampleRate > 30000 ? sampleRate / 2 : sampleRate;
  const edges = logBandEdges(30, Math.min(11000, rate / 2 - 1), 40);
  const env = bandEnvelope(reduced, rate, { windowSize: 1024, hopSize: Math.round(rate / 100), edgesHz: edges });
  const lowTop = edges.findIndex((hz) => hz >= 150);
  const highBottom = edges.findIndex((hz) => hz >= 1500);
  return {
    envelope: spectralFlux(env),
    hop: env.hop,
    offset: env.offset,
    low: spectralFlux(env, { toBand: Math.max(1, lowTop) }),
    high: spectralFlux(env, { fromBand: Math.max(0, highBottom) }),
  };
}

export interface TempoEstimate {
  bpm: number;
  /** Beat period in frames. */
  period: number;
  /** How well the onsets repeat at this period, with its metre and the tempo prior (higher is better). */
  score?: number;
}

/**
 * Beat-period candidates, from the autocorrelation of the onset envelope, best first.
 *
 * The autocorrelation peaks at every lag the rhythm repeats at, and the beat is only one of
 * them. Measured on a plain rock beat (kick on 1, 3 and the "and" of 3): the single strongest
 * peak was a dotted quarter, 2/3 of the true tempo — 97 BPM for a 146 BPM song, every "beat"
 * landing on a real drum hit and the grid still wrong. A true beat is backed by its whole
 * metre: the half-beat below it and the two-beat span above it repeat too. A dotted quarter's
 * half (a dotted eighth) does not. So each candidate is scored with its double and its half,
 * and a log-normal prior around 120 BPM weighs tempo octaves. Which octave is the beat, the
 * autocorrelation alone often cannot tell (measured: a few percent apart, either way); see
 * tempo.ts for how that is settled.
 */
export function tempoCandidates(
  envelope: Float32Array,
  hop: number,
  options: { minBpm?: number; maxBpm?: number; centreBpm?: number } = {},
): TempoEstimate[] {
  const minBpm = options.minBpm ?? 50;
  const maxBpm = options.maxBpm ?? 220;
  const centre = options.centreBpm ?? 120;
  const fps = 1 / hop;
  const minLag = Math.max(2, Math.floor((60 / maxBpm) * fps));
  const maxLag = Math.ceil((60 / minBpm) * fps);
  const longest = 2 * maxLag + 2;

  let mean = 0;
  for (const v of envelope) mean += v;
  mean /= Math.max(1, envelope.length);

  const ac = new Float64Array(longest + 1);
  for (let lag = 1; lag <= longest; lag++) {
    let sum = 0;
    for (let t = 0; t + lag < envelope.length; t++) sum += (envelope[t] - mean) * (envelope[t + lag] - mean);
    ac[lag] = sum / Math.max(1, envelope.length - lag);
  }
  // Linear interpolation, for the half and double of a fractional lag.
  const at = (lag: number) => {
    const i = Math.floor(lag);
    if (i < 1 || i + 1 > longest) return 0;
    return ac[i] + (ac[i + 1] - ac[i]) * (lag - i);
  };

  const out: TempoEstimate[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    // Only true peaks of the autocorrelation are tempo candidates.
    if (ac[lag] < ac[lag - 1] || ac[lag] < ac[lag + 1]) continue;
    // Parabolic interpolation: frames are 10ms, and a 1-frame error at 146 BPM is 2.5% tempo.
    let period = lag;
    const denom = ac[lag - 1] - 2 * ac[lag] + ac[lag + 1];
    if (denom < 0) period = lag + Math.max(-0.5, Math.min(0.5, (0.5 * (ac[lag - 1] - ac[lag + 1])) / denom));
    const bpm = (60 * fps) / period;
    const weight = Math.exp(-0.5 * Math.log2(bpm / centre) ** 2);
    const metre = ac[lag] + 0.5 * at(period * 2) + 0.5 * at(period / 2);
    out.push({ bpm, period, score: metre * weight });
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (!out.length) out.push({ bpm: centre, period: (60 * fps) / centre, score: 0 });
  return out;
}

/** The autocorrelation's best beat period. */
export function estimateTempo(
  envelope: Float32Array,
  hop: number,
  options: { minBpm?: number; maxBpm?: number; centreBpm?: number } = {},
): TempoEstimate {
  return tempoCandidates(envelope, hop, options)[0];
}

export interface BeatTrack {
  /** Beat times in seconds, covering the whole recording. */
  beats: number[];
  /** Beats before this index and after `lastTracked` were extrapolated, not heard. */
  firstTracked: number;
  lastTracked: number;
  /** Median tempo over the tracked beats. */
  bpm: number;
}

/**
 * Dynamic-programming beat tracking.
 *
 * Every frame gets the best score of any beat sequence ending there: its own onset strength
 * plus the best predecessor, penalised by how far the gap strays from the expected period on
 * a log scale. `tightness` sets how hard tempo is held — 100 (librosa's default) still lets a
 * drummer wander a few percent from bar to bar, which is the point.
 */
export function trackBeats(
  onset: OnsetStrength,
  durationSeconds: number,
  options: { tightness?: number; tempo?: TempoEstimate } = {},
): BeatTrack {
  const { envelope, hop, offset } = onset;
  const tempo = options.tempo ?? estimateTempo(envelope, hop);
  const period = tempo.period;
  const tightness = options.tightness ?? 100;
  const n = envelope.length;

  // Normalise, then smear each onset over a narrow Gaussian so the DP can land a beat a frame
  // or two either side of the exact peak.
  let sq = 0;
  for (const v of envelope) sq += v * v;
  const std = Math.sqrt(sq / Math.max(1, n)) || 1;
  const reach = Math.round(period);
  const kernel: number[] = [];
  for (let k = -reach; k <= reach; k++) kernel.push(Math.exp(-0.5 * ((k * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let sum = 0;
    for (let k = -reach; k <= reach; k++) {
      const j = t + k;
      if (j >= 0 && j < n) sum += (envelope[j] / std) * kernel[k + reach];
    }
    local[t] = sum;
  }

  let localMax = 0;
  for (const v of local) localMax = Math.max(localMax, v);
  const startThreshold = 0.01 * localMax;
  const cumulative = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  const from = Math.round(period / 2);
  const to = Math.round(2 * period);
  const logPeriod = Math.log(period);
  let started = false;
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestAt = -1;
    for (let gap = from; gap <= to; gap++) {
      const p = t - gap;
      if (p < 0) break;
      const score = cumulative[p] - tightness * (Math.log(gap) - logPeriod) ** 2;
      if (score > best) {
        best = score;
        bestAt = p;
      }
    }
    cumulative[t] = local[t] + (bestAt >= 0 ? best : 0);
    // Silence before the music starts must not anchor a chain of beats.
    if (!started && local[t] < startThreshold) backlink[t] = -1;
    else {
      backlink[t] = bestAt;
      started = true;
    }
  }

  // The last beat: the latest local maximum of the cumulative score that is not weak.
  const maxima: number[] = [];
  for (let t = 1; t + 1 < n; t++) if (cumulative[t] > cumulative[t - 1] && cumulative[t] >= cumulative[t + 1]) maxima.push(t);
  const sortedMaxima = maxima.map((t) => cumulative[t]).sort((a, b) => a - b);
  const median = sortedMaxima[sortedMaxima.length >> 1] ?? 0;
  let last = -1;
  for (const t of maxima) if (cumulative[t] > 0.5 * median) last = t;
  if (last < 0) last = n - 1;

  const frames: number[] = [];
  for (let t = last; t >= 0; t = backlink[t]) frames.push(t);
  frames.reverse();

  // Drop weak beats at either end: the DP keeps a steady chain going through an intro or an
  // outro with nothing in it, and those beats are guesses.
  const strength = frames.map((f) => local[f]);
  const smooth = strength.map((_, i) => {
    let s = 0;
    let w = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= strength.length) continue;
      const weight = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 3)) / 6);
      s += strength[j] * weight;
      w += weight;
    }
    return s / (w || 1);
  });
  const rms = Math.sqrt(smooth.reduce((s, v) => s + v * v, 0) / Math.max(1, smooth.length));
  let first = 0;
  let end = frames.length - 1;
  while (first < end && smooth[first] <= 0.5 * rms) first++;
  while (end > first && smooth[end] <= 0.5 * rms) end--;
  let kept = frames.slice(first, end + 1);
  // ...and beats at either end that fall out of step. The chain has to end somewhere, and it
  // ends on whatever hit comes last — measured: a funk song's last two beats pulled onto the
  // kick a sixteenth after beat 3, 150ms late; a rock song's last three drifting 60-200ms
  // early to reach its final chord. Beats that leave the line the steady beats before them
  // set are better extrapolated from those.
  const outOfStep = (steadyBeats: number[], steadyAt: number[], probe: number, at: number) => {
    // Least-squares line through the steady beats: frame = a + b * index.
    const n = steadyBeats.length;
    const mx = steadyAt.reduce((s, v) => s + v, 0) / n;
    const my = steadyBeats.reduce((s, v) => s + v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let k = 0; k < n; k++) {
      sxy += (steadyAt[k] - mx) * (steadyBeats[k] - my);
      sxx += (steadyAt[k] - mx) ** 2;
    }
    const slope = sxx ? sxy / sxx : period;
    return Math.abs(probe - (my + slope * (at - mx))) > 0.1 * slope;
  };
  if (kept.length >= 12) {
    const steadyAt = Array.from({ length: 8 }, (_, k) => kept.length - 12 + k);
    const steadyBeats = steadyAt.map((i) => kept[i]);
    let cut = kept.length;
    for (let i = kept.length - 4; i < kept.length; i++) {
      if (outOfStep(steadyBeats, steadyAt, kept[i], i)) {
        cut = i;
        break;
      }
    }
    kept = kept.slice(0, cut);
  }
  if (kept.length >= 12) {
    const steadyAt = Array.from({ length: 8 }, (_, k) => 4 + k);
    const steadyBeats = steadyAt.map((i) => kept[i]);
    let cut = 0;
    for (let i = 3; i >= 0; i--) {
      if (outOfStep(steadyBeats, steadyAt, kept[i], i)) {
        cut = i + 1;
        break;
      }
    }
    kept = kept.slice(cut);
  }

  // Sub-frame timing from the shape of the onset peak around each beat.
  const times = kept.map((f) => {
    let shift = 0;
    if (f > 0 && f + 1 < n) {
      const a = local[f - 1];
      const b = local[f];
      const c = local[f + 1];
      const denom = a - 2 * b + c;
      if (denom < 0) shift = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
    }
    return (f + shift) * hop + offset;
  });

  return extendBeats(times, durationSeconds, tempo);
}

/**
 * Carry the beat grid out to both ends of the recording at the local tempo, so a note played
 * before the first drum hit, or after the last, still has a beat to be written against.
 */
export function extendBeats(tracked: number[], durationSeconds: number, tempo: TempoEstimate): BeatTrack {
  const fallback = 60 / tempo.bpm;
  if (tracked.length < 2) {
    const beats: number[] = [];
    for (let t = 0; t < durationSeconds + fallback; t += fallback) beats.push(t);
    return { beats, firstTracked: 0, lastTracked: beats.length - 1, bpm: tempo.bpm };
  }
  const span = (list: number[], from: number, count: number) => {
    const slice = list.slice(Math.max(0, from), Math.max(0, from) + count);
    return (slice[slice.length - 1] - slice[0]) / Math.max(1, slice.length - 1);
  };
  const startPeriod = span(tracked, 0, 5) || fallback;
  const endPeriod = span(tracked, tracked.length - 5, 5) || fallback;

  const before: number[] = [];
  for (let t = tracked[0] - startPeriod; t > -startPeriod; t -= startPeriod) before.unshift(t);
  const after: number[] = [];
  for (let t = tracked[tracked.length - 1] + endPeriod; t < durationSeconds + endPeriod; t += endPeriod) after.push(t);

  const gaps = tracked.slice(1).map((t, i) => t - tracked[i]).sort((a, b) => a - b);
  const medianGap = gaps[gaps.length >> 1];
  return {
    beats: [...before, ...tracked, ...after],
    firstTracked: before.length,
    lastTracked: before.length + tracked.length - 1,
    bpm: 60 / medianGap,
  };
}
