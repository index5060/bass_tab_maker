import { describe, it, expect } from 'vitest';
import {
  detectPitch,
  trackPitch,
  decimate,
  toMono,
  hzToMidi,
  midiToHz,
  midiToName,
} from './pitch';

const SR = 11025;

/**
 * A plucked-bass-ish tone: a fundamental plus a couple of harmonics, since a pure sine is an
 * unrealistically easy target and would hide the octave errors this detector exists to avoid.
 */
function tone(hz: number, samples: number, sampleRate = SR, amp = 0.5): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    out[i] =
      amp *
      (Math.sin(2 * Math.PI * hz * t) +
        0.5 * Math.sin(2 * Math.PI * hz * 2 * t) +
        0.25 * Math.sin(2 * Math.PI * hz * 3 * t));
  }
  return out;
}

function centsOff(detected: number, expected: number): number {
  return Math.abs(1200 * Math.log2(detected / expected));
}

describe('detectPitch on known tones', () => {
  // Open strings of a 4-string bass, plus a couple of fretted notes.
  const cases: Array<[string, number]> = [
    ['E1 (open E)', 41.2],
    ['A1 (open A)', 55.0],
    ['D2 (open D)', 73.42],
    ['G2 (open G)', 98.0],
    ['C2 (E string, 8th fret)', 65.41],
    ['E2 (D string, 2nd fret)', 82.41],
    ['A2 (G string, 2nd fret)', 110.0],
    ['D3 (G string, 7th fret)', 146.83],
  ];

  for (const [label, hz] of cases) {
    it(`finds ${label} within 20 cents`, () => {
      const result = detectPitch(tone(hz, 2048), { sampleRate: SR });
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(centsOff(result.hz, hz)).toBeLessThan(20);
    });
  }

  it('does not drop an octave on a strong fundamental', () => {
    // The classic autocorrelation failure: reporting 20.6Hz for a 41.2Hz note.
    const result = detectPitch(tone(41.2, 2048), { sampleRate: SR });
    expect(result.hz).toBeGreaterThan(35);
  });

  it('does not jump an octave up either', () => {
    const result = detectPitch(tone(55, 2048), { sampleRate: SR });
    expect(result.hz).toBeLessThan(80);
  });

  it('reports no confidence for silence', () => {
    const result = detectPitch(new Float32Array(2048), { sampleRate: SR });
    expect(result.confidence).toBe(0);
  });

  it('reports low confidence for white noise', () => {
    const noise = new Float32Array(2048);
    let seed = 12345;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (seed / 0x3fffffff - 1) * 0.5;
    }
    expect(detectPitch(noise, { sampleRate: SR }).confidence).toBeLessThan(0.6);
  });

  it('survives a note decaying in amplitude', () => {
    const n = 2048;
    const decaying = tone(55, n);
    for (let i = 0; i < n; i++) decaying[i] *= Math.exp(-3 * (i / n));
    expect(centsOff(detectPitch(decaying, { sampleRate: SR }).hz, 55)).toBeLessThan(25);
  });

  it('never answers outside the range it was given', () => {
    // A 55Hz tone has harmonics at 110 and 165Hz, so a 200-500Hz search should find nothing
    // periodic at all. Reporting 0 is the honest answer; the contract being tested is only
    // that the out-of-range fundamental never comes back.
    const result = detectPitch(tone(55, 2048), { sampleRate: SR, minHz: 200, maxHz: 500 });
    expect(result.hz === 0 || result.hz >= 200).toBe(true);
  });
});

describe('trackPitch', () => {
  it('follows a note change', () => {
    const first = tone(55, SR); // 1s of A1
    const second = tone(82.41, SR); // 1s of E2
    const joined = new Float32Array(first.length + second.length);
    joined.set(first, 0);
    joined.set(second, first.length);

    const frames = trackPitch(joined, { sampleRate: SR });
    const early = frames.filter((f) => f.timeMs > 200 && f.timeMs < 800 && f.confidence > 0.7);
    const late = frames.filter((f) => f.timeMs > 1200 && f.timeMs < 1800 && f.confidence > 0.7);

    expect(early.length).toBeGreaterThan(5);
    expect(late.length).toBeGreaterThan(5);
    expect(centsOff(median(early.map((f) => f.hz)), 55)).toBeLessThan(25);
    expect(centsOff(median(late.map((f) => f.hz)), 82.41)).toBeLessThan(25);
  });

  it('marks silence as unvoiced', () => {
    const frames = trackPitch(new Float32Array(SR), { sampleRate: SR });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.confidence === 0)).toBe(true);
  });

  it('reports rising level for a swell', () => {
    const n = SR;
    const swell = tone(55, n);
    for (let i = 0; i < n; i++) swell[i] *= i / n;
    const frames = trackPitch(swell, { sampleRate: SR });
    expect(frames[frames.length - 1].rms).toBeGreaterThan(frames[0].rms);
  });
});

describe('decimate', () => {
  it('shortens by the factor', () => {
    expect(decimate(new Float32Array(4000), 4).length).toBe(1000);
  });

  it('preserves pitch through decimation', () => {
    const at44k = tone(55, 8192, 44100);
    const at11k = decimate(at44k, 4);
    const result = detectPitch(at11k, { sampleRate: 11025 });
    expect(centsOff(result.hz, 55)).toBeLessThan(25);
  });

  it('passes the signal through unchanged at factor 1', () => {
    const input = tone(55, 512);
    expect(decimate(input, 1)).toBe(input);
  });
});

describe('toMono', () => {
  it('averages the two channels', () => {
    const l = Float32Array.from([1, 0, -1]);
    const r = Float32Array.from([0, 1, 1]);
    expect(Array.from(toMono(l, r))).toEqual([0.5, 0.5, 0]);
  });

  it('truncates to the shorter channel', () => {
    expect(toMono(new Float32Array(10), new Float32Array(4)).length).toBe(4);
  });
});

describe('midi conversions', () => {
  it('maps A4 to 69', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 6);
    expect(midiToHz(69)).toBeCloseTo(440, 6);
  });

  it('maps the open strings of a bass', () => {
    expect(Math.round(hzToMidi(41.203))).toBe(28); // E1
    expect(Math.round(hzToMidi(55))).toBe(33); // A1
    expect(Math.round(hzToMidi(73.416))).toBe(38); // D2
    expect(Math.round(hzToMidi(97.999))).toBe(43); // G2
  });

  it('names notes', () => {
    expect(midiToName(28)).toBe('E1');
    expect(midiToName(33)).toBe('A1');
    expect(midiToName(43)).toBe('G2');
  });

  it('round trips', () => {
    for (let m = 28; m <= 67; m++) expect(hzToMidi(midiToHz(m))).toBeCloseTo(m, 6);
  });
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
