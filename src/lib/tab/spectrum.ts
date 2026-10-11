/**
 * The spectral measurements the tab pipeline is built on: how loud each frequency band is,
 * frame by frame, and how sharply it rises — the "something was just struck" signal that
 * both beat tracking (on the band) and note detection (on the bass) start from.
 *
 * Kept to band energies rather than full spectra on purpose: a four-minute song at 100 frames
 * a second and 513 bins is ~50MB of floats, while 48 bands is ~5MB. Nothing downstream needs
 * finer frequency detail than the bands give.
 */

/** cos/sin of -2πk/n for k < n/2, per transform size: computing them per butterfly cost ~10x. */
const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddleTable(n: number): { cos: Float64Array; sin: Float64Array } {
  let table = twiddles.get(n);
  if (!table) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((-2 * Math.PI * k) / n);
      sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    table = { cos, sin };
    twiddles.set(n, table);
  }
  return table;
}

/** In-place radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const { cos, sin } = twiddleTable(n);
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Band edges spaced evenly in log frequency — roughly how hearing, and music, divide pitch. */
export function logBandEdges(minHz: number, maxHz: number, bands: number): number[] {
  const edges: number[] = [];
  for (let i = 0; i <= bands; i++) edges.push(minHz * Math.pow(maxHz / minHz, i / bands));
  return edges;
}

export interface BandEnvelope {
  /** frames × bands, row-major: level in dB of each band in each frame. */
  levels: Float32Array;
  frames: number;
  bands: number;
  /** Seconds between frames. */
  hop: number;
  /** Time of frame i is i * hop + offset (the centre of its window). */
  offset: number;
}

/**
 * Short-time band levels in dB.
 *
 * Levels are floored 80dB under the loudest band of the whole signal, so silence reads as a
 * flat floor rather than as -inf, and a level jump means something was played.
 */
export function bandEnvelope(
  signal: Float32Array,
  sampleRate: number,
  options: { windowSize: number; hopSize: number; edgesHz: number[] },
): BandEnvelope {
  const { windowSize, hopSize, edgesHz } = options;
  const bands = edgesHz.length - 1;
  const frames = Math.max(0, Math.floor((signal.length - windowSize) / hopSize) + 1);
  const levels = new Float32Array(frames * bands);
  const window = new Float64Array(windowSize);
  for (let i = 0; i < windowSize; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / windowSize);

  // Which FFT bins feed which band. Narrow low bands may fall between bins; they then take
  // the nearest bin, so every band always measures something.
  const binHz = sampleRate / windowSize;
  const bandBins: Array<[number, number]> = [];
  for (let b = 0; b < bands; b++) {
    const lo = Math.max(1, Math.floor(edgesHz[b] / binHz));
    const hi = Math.min(windowSize / 2, Math.max(lo + 1, Math.ceil(edgesHz[b + 1] / binHz)));
    bandBins.push([lo, hi]);
  }

  const re = new Float64Array(windowSize);
  const im = new Float64Array(windowSize);
  let loudest = -Infinity;
  for (let f = 0; f < frames; f++) {
    const start = f * hopSize;
    for (let i = 0; i < windowSize; i++) {
      re[i] = signal[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bands; b++) {
      const [lo, hi] = bandBins[b];
      let energy = 0;
      for (let k = lo; k < hi; k++) energy += re[k] * re[k] + im[k] * im[k];
      const db = 10 * Math.log10(energy / (hi - lo) + 1e-12);
      levels[f * bands + b] = db;
      if (db > loudest) loudest = db;
    }
  }
  const floor = loudest - 80;
  for (let i = 0; i < levels.length; i++) if (levels[i] < floor) levels[i] = floor;
  return { levels, frames, bands, hop: hopSize / sampleRate, offset: windowSize / 2 / sampleRate };
}

/**
 * How much the spectrum rose, frame by frame ("spectral flux").
 *
 * Each band is compared with the loudest of its neighbours `lag` frames earlier (SuperFlux,
 * Böck & Widmer 2013): a note that only wobbles in pitch — vibrato, a bend, a slide — moves
 * energy into a neighbouring band without anything being struck, and comparing against the
 * neighbours keeps that from reading as a new attack.
 *
 * `fromBand`/`toBand` restrict the sum, e.g. to the kick drum's register.
 */
export function spectralFlux(
  env: BandEnvelope,
  options: { lag?: number; fromBand?: number; toBand?: number } = {},
): Float32Array {
  const lag = options.lag ?? 1;
  const from = options.fromBand ?? 0;
  const to = options.toBand ?? env.bands;
  const out = new Float32Array(env.frames);
  for (let f = lag; f < env.frames; f++) {
    let sum = 0;
    for (let b = from; b < to; b++) {
      let previous = env.levels[(f - lag) * env.bands + b];
      if (b > 0) previous = Math.max(previous, env.levels[(f - lag) * env.bands + b - 1]);
      if (b + 1 < env.bands) previous = Math.max(previous, env.levels[(f - lag) * env.bands + b + 1]);
      const rise = env.levels[f * env.bands + b] - previous;
      if (rise > 0) sum += rise;
    }
    out[f] = sum / Math.max(1, to - from);
  }
  return out;
}

/**
 * Spectral flux of a separated stem that the rest of the mix does not explain.
 *
 * Separation leaves some of the band in the bass stem, and a drum hit or a guitar chord there
 * is a broadband rise like any pluck — measured with the band 20dB down in the bass stem: an
 * extra "note" on every kick drum under a held bass note, and the guitar's intro played as a
 * bass line. Leakage is a scaled copy of the band, so in each frequency band it sits a fixed
 * number of dB under the band; that number shows up as the floor of (stem − band) over the
 * song, where the bass is silent and only the leak is left. Wherever the stem is no louder
 * than that leak, its rise is the band's, and is not counted. Where the bass itself is well
 * above the leak, its rises are its own, whatever the drums are doing at the same moment.
 */
/** Leakage sits at least this far (dB) under its source. */
const LEAK_BELOW = 6;

export function residualFlux(
  env: BandEnvelope,
  other: BandEnvelope,
  options: { lag?: number; fromBand?: number; toBand?: number } = {},
): Float32Array {
  const lag = options.lag ?? 1;
  const from = options.fromBand ?? 0;
  const to = options.toBand ?? env.bands;
  const frames = Math.min(env.frames, other.frames);
  const bands = env.bands;

  // The leak, band by band: the low end (5th percentile) of stem − band where the band plays.
  const leak = new Float64Array(bands).fill(-Infinity);
  for (let b = from; b < to; b++) {
    let otherMax = -Infinity;
    for (let f = 0; f < frames; f++) otherMax = Math.max(otherMax, other.levels[f * bands + b]);
    const differences: number[] = [];
    for (let f = 0; f < frames; f++) {
      const o = other.levels[f * bands + b];
      if (o > otherMax - 40) differences.push(env.levels[f * bands + b] - o);
    }
    if (differences.length < 20) continue;
    differences.sort((x, y) => x - y);
    const floor = differences[Math.floor(differences.length * 0.05)];
    // Leakage is attenuated — that is what separation does. A floor that is not well under
    // the band means the stem holds its own sound there even at its quietest (or the band
    // stem holds the bass: leakage the other way), and then no rise of it is the band's.
    if (floor < -LEAK_BELOW) leak[b] = floor;
  }

  const previous = (e: BandEnvelope, f: number, b: number) => {
    let p = e.levels[(f - lag) * bands + b];
    if (b > 0) p = Math.max(p, e.levels[(f - lag) * bands + b - 1]);
    if (b + 1 < bands) p = Math.max(p, e.levels[(f - lag) * bands + b + 1]);
    return p;
  };
  const out = new Float32Array(env.frames);
  for (let f = lag; f < env.frames; f++) {
    let sum = 0;
    for (let b = from; b < to; b++) {
      const level = env.levels[f * bands + b];
      let rise = level - previous(env, f, b);
      if (rise <= 0) continue;
      // Within 6dB of the leak, the stem is (mostly) the band: its rise is the band's.
      if (f < frames && level < other.levels[f * bands + b] + leak[b] + 6) {
        rise -= Math.max(0, other.levels[f * bands + b] - previous(other, f, b));
      }
      if (rise > 0) sum += rise;
    }
    out[f] = sum / Math.max(1, to - from);
  }
  return out;
}

/** Halve the sample rate after a short low-pass, so nothing above the new Nyquist folds back. */
export function halfRate(signal: Float32Array): Float32Array {
  // 15-tap windowed-sinc half-band filter: plenty for onset and level measurements.
  const taps = [-0.0028, 0, 0.0158, 0, -0.0565, 0, 0.2935, 0.5, 0.2935, 0, -0.0565, 0, 0.0158, 0, -0.0028];
  const half = taps.length >> 1;
  const out = new Float32Array(Math.floor(signal.length / 2));
  for (let i = 0; i < out.length; i++) {
    const centre = i * 2;
    let sum = 0;
    for (let k = 0; k < taps.length; k++) {
      const j = centre + k - half;
      if (j >= 0 && j < signal.length) sum += signal[j] * taps[k];
    }
    out[i] = sum;
  }
  return out;
}
