import { describe, it, expect } from 'vitest';
import {
  sumStems,
  subtractStems,
  buildMinusBass,
  peakOf,
  encodeWavBuffer,
  decodeWavBuffer,
  type StemChannels,
  type DemucsResult,
} from './stems';

/** A stem whose samples are a known ramp, so sums are easy to reason about. */
function ramp(length: number, scale: number): StemChannels {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    left[i] = (i / length) * scale;
    right[i] = -(i / length) * scale;
  }
  return { left, right };
}

function tone(length: number, freq: number, sampleRate: number, amp = 0.5): StemChannels {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    left[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp;
    right[i] = Math.cos((2 * Math.PI * freq * i) / sampleRate) * amp;
  }
  return { left, right };
}

describe('sumStems', () => {
  it('adds sample by sample', () => {
    const a = ramp(8, 0.2);
    const b = ramp(8, 0.3);
    const out = sumStems([a, b]);
    for (let i = 0; i < 8; i++) {
      expect(out.left[i]).toBeCloseTo(a.left[i] + b.left[i], 6);
      expect(out.right[i]).toBeCloseTo(a.right[i] + b.right[i], 6);
    }
  });

  it('does not normalise (minus-one must stay as loud as the original)', () => {
    const a = ramp(4, 1);
    const out = sumStems([a, a, a]);
    expect(out.left[3]).toBeCloseTo(a.left[3] * 3, 6);
  });

  it('rejects mismatched lengths', () => {
    expect(() => sumStems([ramp(8, 1), ramp(9, 1)])).toThrow(/길이/);
  });

  it('rejects an empty list', () => {
    expect(() => sumStems([])).toThrow();
  });
});

describe('buildMinusBass', () => {
  it('is exactly original minus bass', () => {
    const n = 256;
    const sr = 44100;
    const result: DemucsResult = {
      drums: tone(n, 120, sr, 0.2),
      bass: tone(n, 60, sr, 0.3),
      other: tone(n, 440, sr, 0.15),
      vocals: tone(n, 880, sr, 0.1),
    };
    // Demucs stems are additive, so this is what the original would have been.
    const original = sumStems([result.drums, result.bass, result.other, result.vocals]);
    const minusBass = buildMinusBass(result);

    for (let i = 0; i < n; i++) {
      expect(minusBass.left[i]).toBeCloseTo(original.left[i] - result.bass.left[i], 6);
      expect(minusBass.right[i]).toBeCloseTo(original.right[i] - result.bass.right[i], 6);
    }
  });

  it('leaves out the bass stem entirely', () => {
    const n = 64;
    const silent: StemChannels = { left: new Float32Array(n), right: new Float32Array(n) };
    const loudBass = tone(n, 60, 44100, 0.9);
    const minusBass = buildMinusBass({
      drums: silent,
      other: silent,
      vocals: silent,
      bass: loudBass,
    });
    expect(peakOf(minusBass)).toBe(0);
  });

  it('bass + minusBass reconstructs the original', () => {
    const n = 512;
    const result: DemucsResult = {
      drums: tone(n, 100, 44100, 0.2),
      bass: tone(n, 55, 44100, 0.25),
      other: tone(n, 330, 44100, 0.2),
      vocals: tone(n, 660, 44100, 0.15),
    };
    const original = sumStems([result.drums, result.bass, result.other, result.vocals]);
    const rebuilt = sumStems([result.bass, buildMinusBass(result)]);
    for (let i = 0; i < n; i++) {
      expect(rebuilt.left[i]).toBeCloseTo(original.left[i], 6);
    }
  });
});

describe('subtractStems', () => {
  it('recovers the minus-one track from original and bass alone', () => {
    // This is the import path: you only kept bass.wav from a local Demucs run.
    const n = 256;
    const sr = 44100;
    const bass = tone(n, 55, sr, 0.3);
    const rest = sumStems([tone(n, 100, sr, 0.2), tone(n, 440, sr, 0.2)]);
    const original = sumStems([bass, rest]);

    const derived = subtractStems(original, bass);
    for (let i = 0; i < n; i++) {
      expect(derived.left[i]).toBeCloseTo(rest.left[i], 6);
      expect(derived.right[i]).toBeCloseTo(rest.right[i], 6);
    }
  });

  it('subtracting a track from itself gives silence', () => {
    const t = tone(128, 220, 44100, 0.7);
    expect(peakOf(subtractStems(t, t))).toBeCloseTo(0, 9);
  });

  it('truncates to the shorter input rather than reading past the end', () => {
    const out = subtractStems(ramp(100, 1), ramp(40, 1));
    expect(out.left.length).toBe(40);
    expect(Number.isFinite(out.left[39])).toBe(true);
  });
});

describe('peakOf', () => {
  it('finds the largest magnitude across both channels', () => {
    const ch: StemChannels = {
      left: Float32Array.from([0.1, -0.4, 0.2]),
      right: Float32Array.from([0.3, 0.05, -0.7]),
    };
    expect(peakOf(ch)).toBeCloseTo(0.7, 6);
  });
});

describe('WAV codec', () => {
  it('writes a valid RIFF/WAVE header', () => {
    const buf = encodeWavBuffer(ramp(10, 0.5), 44100);
    const view = new DataView(buf);
    const tag = (o: number) =>
      String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(tag(36)).toBe('data');
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16); // bit depth
  });

  it('has the byte length the header claims', () => {
    const frames = 100;
    const buf = encodeWavBuffer(ramp(frames, 0.5), 48000);
    const view = new DataView(buf);
    expect(buf.byteLength).toBe(44 + frames * 4);
    expect(view.getUint32(40, true)).toBe(frames * 4);
    expect(view.getUint32(4, true)).toBe(36 + frames * 4);
  });

  it('round-trips within 16-bit quantisation error', () => {
    const sr = 44100;
    const src = tone(1024, 220, sr, 0.8);
    const { channels, sampleRate } = decodeWavBuffer(encodeWavBuffer(src, sr));
    expect(sampleRate).toBe(sr);
    expect(channels.left.length).toBe(src.left.length);
    for (let i = 0; i < src.left.length; i++) {
      expect(channels.left[i]).toBeCloseTo(src.left[i], 4);
      expect(channels.right[i]).toBeCloseTo(src.right[i], 4);
    }
  });

  it('clamps rather than wraps on overshoot', () => {
    const hot: StemChannels = {
      left: Float32Array.from([1.8, -1.8, 0]),
      right: Float32Array.from([-2.5, 2.5, 0]),
    };
    const { channels } = decodeWavBuffer(encodeWavBuffer(hot, 44100));
    // Wrapping would flip the sign — that is the bug this guards against.
    expect(channels.left[0]).toBeGreaterThan(0.99);
    expect(channels.left[1]).toBeLessThan(-0.99);
    expect(channels.right[0]).toBeLessThan(-0.99);
    expect(channels.right[1]).toBeGreaterThan(0.99);
  });

  it('preserves silence exactly', () => {
    const n = 32;
    const silent: StemChannels = { left: new Float32Array(n), right: new Float32Array(n) };
    const { channels } = decodeWavBuffer(encodeWavBuffer(silent, 44100));
    expect(peakOf(channels)).toBe(0);
  });

  it('rejects non-WAV input', () => {
    expect(() => decodeWavBuffer(new ArrayBuffer(64))).toThrow(/WAV/);
  });
});
