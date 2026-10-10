import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeWav, looksLikeWav, readWavInfo, toStereo, UnsupportedWavError } from './wav';

/*
 * Fixtures: one 0.1s stereo clip (110Hz left, 220Hz right, 8kHz) encoded by ffmpeg into each
 * format, next to ffmpeg's own decode of that file as float32 (`.ref.f32`). The reader has to
 * reproduce ffmpeg's samples — for the lossy formats too, since ffmpeg's decoder is the
 * reference for what those bytes mean.
 */
const FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'wav');

function load(name: string): ArrayBuffer {
  const b = fs.readFileSync(path.join(FIXTURES, `${name}.wav`));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function reference(name: string, channels: number): Float32Array[] {
  const b = fs.readFileSync(path.join(FIXTURES, `${name}.ref.f32`));
  const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const frames = all.length / channels;
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => all[i * channels + c]));
}

function maxDifference(a: Float32Array[], b: Float32Array[]): number {
  let worst = 0;
  for (let c = 0; c < a.length; c++) {
    const n = Math.min(a[c].length, b[c].length);
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(a[c][i] - b[c][i]));
  }
  return worst;
}

describe('decodeWav matches ffmpeg', () => {
  it.each([
    ['pcm8', 'PCM 8비트'],
    ['pcm16', 'PCM 16비트'],
    ['pcm24', 'PCM 24비트'],
    ['pcm32', 'PCM 32비트'],
    ['float32', 'float 32비트'],
    // Chromium cannot decode or play this one at all.
    ['float64', 'float 64비트'],
    ['mulaw', 'µ-law'],
    ['alaw', 'A-law'],
    ['rf64', 'PCM 16비트'],
  ])('%s', (name, formatName) => {
    const decoded = decodeWav(load(name));
    expect(decoded.info.formatName).toBe(formatName);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channels).toHaveLength(2);
    expect(decoded.channels[0].length).toBe(800);
    // One step of 8-bit is 1/128; everything else is far tighter.
    expect(maxDifference(decoded.channels, reference(name, 2))).toBeLessThan(name === 'pcm8' ? 1 / 64 : 1e-4);
  });

  it.each(['ima_adpcm', 'ms_adpcm'])('%s — compressed, unreadable by Chromium', (name) => {
    const decoded = decodeWav(load(name));
    const ref = reference(name, 2);
    // ffmpeg decodes the padding at the end of the last block too; the 'fact' chunk says where
    // the real audio stops, and that is where this reader stops.
    expect(decoded.channels[0].length).toBe(800);
    // IMA: the spec (and Microsoft's decoder) builds each step from truncated shifts, while
    // ffmpeg computes (2d+1)·step/8 in one go. Both are in use; they differ by a few LSB
    // (here at most 16/32768, -66dB). This reader follows the spec.
    expect(maxDifference(decoded.channels, ref)).toBeLessThan(name === 'ima_adpcm' ? 1e-3 : 1e-4);
  });

  it('reads the RF64 container that very long recordings use', () => {
    expect(readWavInfo(load('rf64')).container).toBe('RF64');
  });

  it('reads 5.1 surround and folds it to stereo with the centre and LFE kept', () => {
    const decoded = decodeWav(load('surround51'));
    expect(decoded.channels).toHaveLength(6);
    expect(decoded.info.extensible).toBe(true);
    expect(maxDifference(decoded.channels, reference('surround51', 6))).toBeLessThan(1e-4);
    const { left, right } = toStereo(decoded.channels);
    expect(left).toHaveLength(800);
    expect(right).toHaveLength(800);
  });
});

/* A WAV built byte by byte, to cover the header layouts real software writes. */
function buildWav(options: {
  chunksBeforeFmt?: Array<[string, number]>;
  chunksBeforeData?: Array<[string, number]>;
  dataSize?: number;
  fmtAfterData?: boolean;
  formatCode?: number;
}): ArrayBuffer {
  const frames = 100;
  const samples = new Int16Array(frames * 2).map((_, i) => (i % 2 ? -1000 : 1000));
  const chunk = (id: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, options.formatCode ?? 1, true);
  fmt.setUint16(2, 2, true);
  fmt.setUint32(4, 44100, true);
  fmt.setUint32(8, 44100 * 4, true);
  fmt.setUint16(12, 4, true);
  fmt.setUint16(14, 16, true);
  const fmtChunk = chunk('fmt ', new Uint8Array(fmt.buffer));
  const dataChunk = chunk('data', new Uint8Array(samples.buffer));
  if (options.dataSize !== undefined) new DataView(dataChunk.buffer).setUint32(4, options.dataSize, true);
  const extra = (list: Array<[string, number]> = []) => list.map(([id, n]) => chunk(id, new Uint8Array(n).fill(7)));

  const parts = options.fmtAfterData
    ? [...extra(options.chunksBeforeFmt), dataChunk, fmtChunk]
    : [...extra(options.chunksBeforeFmt), fmtChunk, ...extra(options.chunksBeforeData), dataChunk];
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + body);
  out.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

describe('readWavInfo walks the chunks', () => {
  const expectClip = (buffer: ArrayBuffer) => {
    const decoded = decodeWav(buffer);
    expect(decoded.channels[0].length).toBe(100);
    expect(decoded.channels[0][0]).toBeCloseTo(1000 / 32768, 6);
    expect(decoded.channels[1][0]).toBeCloseTo(-1000 / 32768, 6);
  };

  it('with metadata chunks before the format (LIST, bext from broadcast WAV)', () => {
    expectClip(buildWav({ chunksBeforeFmt: [['LIST', 26], ['bext', 602]] }));
  });

  it('with chunks between the format and the audio', () => {
    expectClip(buildWav({ chunksBeforeData: [['LIST', 40], ['iXML', 300]] }));
  });

  it('with an odd-sized chunk and its pad byte', () => {
    expectClip(buildWav({ chunksBeforeData: [['junk', 7]] }));
  });

  it.each([0, 0xffffffff])('with the data size left at %d by an interrupted recorder', (size) => {
    expectClip(buildWav({ dataSize: size }));
  });

  it('with the format chunk after the audio', () => {
    expectClip(buildWav({ fmtAfterData: true }));
  });

  it('from just the start of a file, the way a header is read from a slice', () => {
    const full = buildWav({ chunksBeforeFmt: [['LIST', 26]] });
    const info = readWavInfo(full.slice(0, 120), full.byteLength);
    expect(info.dataBytes).toBe(400);
    expect(info.sampleRate).toBe(44100);
  });
});

describe('what it will not read', () => {
  it('names the format it does not decode, so the browser can be asked instead', () => {
    expect(() => decodeWav(buildWav({ formatCode: 0x0055 }))).toThrow(UnsupportedWavError);
    expect(() => decodeWav(buildWav({ formatCode: 0x0055 }))).toThrow(/MP3/);
  });

  it('says what is wrong with something that is not a WAV', () => {
    expect(looksLikeWav(new TextEncoder().encode('ID3\u0004 not a wav at all'))).toBe(false);
    expect(() => readWavInfo(new TextEncoder().encode('OggS........').buffer)).toThrow(/WAV 파일이 아닙니다/);
  });
});
