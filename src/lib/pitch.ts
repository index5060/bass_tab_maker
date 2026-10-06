/**
 * Monophonic pitch tracking (YIN).
 *
 * This only works because separation runs first. Picking the bass out of a full mix is a
 * hard polyphonic problem; picking the pitch out of an *already isolated* bass stem is a
 * classic autocorrelation job — one note at a time, in a low register, with everything else
 * already removed.
 *
 * YIN rather than plain autocorrelation because plain autocorrelation loves to answer an
 * octave too low on a strong fundamental, which on a bass is exactly the mistake you cannot
 * afford. The cumulative mean normalised difference in step 2 is the part that suppresses it.
 *
 * Reference: de Cheveigné & Kawahara (2002), "YIN, a fundamental frequency estimator for
 * speech and music".
 *
 * Pure functions, no DOM, so the whole thing is testable against synthetic tones.
 */

export interface PitchOptions {
  sampleRate: number;
  /** Lowest pitch to look for. Default 35Hz, comfortably under a 4-string bass's E1 (41.2Hz). */
  minHz?: number;
  /** Highest. Default 500Hz — above the 20th fret on the G string. */
  maxHz?: number;
  /** YIN's absolute threshold. Lower = stricter. */
  threshold?: number;
}

export interface PitchResult {
  /** 0 when nothing periodic was found. */
  hz: number;
  /** 0..1, how periodic the window was. */
  confidence: number;
}

export interface PitchFrame extends PitchResult {
  timeMs: number;
  rms: number;
}

const DEFAULT_MIN_HZ = 35;
const DEFAULT_MAX_HZ = 500;
const DEFAULT_THRESHOLD = 0.15;

/**
 * One window in, one pitch out.
 *
 * `buffer` needs to hold at least two periods of the lowest pitch you want to find, so at
 * 11025Hz and 35Hz that is ~630 samples; 1024 is the comfortable choice.
 */
export function detectPitch(buffer: Float32Array, opts: PitchOptions): PitchResult {
  const { sampleRate } = opts;
  const minHz = opts.minHz ?? DEFAULT_MIN_HZ;
  const maxHz = opts.maxHz ?? DEFAULT_MAX_HZ;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  const halfN = buffer.length >> 1;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(halfN - 1, Math.ceil(sampleRate / minHz));
  if (tauMax <= tauMin) return { hz: 0, confidence: 0 };

  // 1. Difference function.
  const diff = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < halfN; j++) {
      const delta = buffer[j] - buffer[j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // 2. Cumulative mean normalised difference. This is what stops the detector from
  //    happily reporting half the true frequency.
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = runningSum > 0 ? (diff[tau] * (tau - tauMin + 1)) / runningSum : 1;
  }

  // 3. First dip below the threshold, then walk down to the bottom of that dip. Taking the
  //    first qualifying dip rather than the global minimum is deliberate: the global minimum
  //    is often at an integer multiple of the true period.
  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) {
    // Nothing convincing. Report the best candidate anyway with the confidence it earned,
    // so callers can decide with their own gate instead of getting a bare zero.
    let best = tauMin;
    for (let tau = tauMin; tau <= tauMax; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
    const confidence = Math.max(0, 1 - cmnd[best]);
    if (confidence <= 0) return { hz: 0, confidence: 0 };
    return { hz: sampleRate / refineTau(cmnd, best, tauMin, tauMax), confidence };
  }

  return {
    hz: sampleRate / refineTau(cmnd, tauEstimate, tauMin, tauMax),
    confidence: Math.max(0, Math.min(1, 1 - cmnd[tauEstimate])),
  };
}

/** Parabolic interpolation around the dip, for sub-sample period resolution. */
function refineTau(cmnd: Float32Array, tau: number, tauMin: number, tauMax: number): number {
  if (tau <= tauMin || tau >= tauMax) return tau;
  const a = cmnd[tau - 1];
  const b = cmnd[tau];
  const c = cmnd[tau + 1];
  const denom = 2 * (2 * b - a - c);
  if (denom === 0) return tau;
  const shift = (a - c) / denom;
  // A parabola fitted to noise can throw the estimate a long way; keep it inside the bin.
  return tau + Math.max(-1, Math.min(1, shift));
}

/* ------------------------------------------------------------- downsample */

/**
 * Decimate by an integer factor, box-filtering first.
 *
 * Bass content lives under ~400Hz, so 44100 -> 11025 keeps everything that matters and makes
 * YIN four times cheaper — and, more importantly, shortens the window needed to hold two
 * periods of a low E.
 */
export function decimate(samples: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return samples;
  const outLength = Math.floor(samples.length / factor);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += samples[base + k];
    out[i] = sum / factor;
  }
  return out;
}

/** Average the channels — stereo position tells us nothing about pitch. */
export function toMono(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i] + right[i]) / 2;
  return out;
}

/* ------------------------------------------------------------------ track */

export interface TrackOptions extends PitchOptions {
  windowSize?: number;
  hopSize?: number;
}

/** Slide a window over the whole signal and report pitch, confidence and level per frame. */
export function trackPitch(samples: Float32Array, opts: TrackOptions): PitchFrame[] {
  const windowSize = opts.windowSize ?? 1024;
  const hopSize = opts.hopSize ?? 128;
  const frames: PitchFrame[] = [];

  for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
    const window = samples.subarray(start, start + windowSize);

    let energy = 0;
    for (let i = 0; i < window.length; i++) energy += window[i] * window[i];
    const rms = Math.sqrt(energy / window.length);

    // Silence has no pitch, and running YIN on it just burns time producing noise.
    const { hz, confidence } = rms < 1e-4 ? { hz: 0, confidence: 0 } : detectPitch(window, opts);

    frames.push({
      timeMs: ((start + windowSize / 2) / opts.sampleRate) * 1000,
      hz,
      confidence,
      rms,
    });
  }

  return frames;
}

/* -------------------------------------------------------------- utilities */

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToName(midi: number): string {
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}
