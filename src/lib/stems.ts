/**
 * Stem separation data model + WAV codec.
 *
 * Demucs gives back four stems — drums, bass, other, vocals — that sum back to the original.
 * For bass practice we only ever want two of the possible mixes:
 *
 *   bass       = the bass stem alone          -> "what did the player actually play?"
 *   minusBass  = drums + other + vocals       -> minus-one, you fill the bass seat
 *
 * and the original is just `bass + minusBass`, so we never need to keep a third copy.
 * Two buffers, three listening modes, and the mix slider moves continuously between them.
 *
 * Everything here is pure (no DOM, no Web Audio) so it can be unit tested in Node.
 */

export interface StemChannels {
  left: Float32Array;
  right: Float32Array;
}

/** Exactly the shape demucs-web's `separate()` resolves to. */
export interface DemucsResult {
  drums: StemChannels;
  bass: StemChannels;
  other: StemChannels;
  vocals: StemChannels;
}

export interface StemSet {
  /** 16-bit PCM WAV of the isolated bass. */
  bass: Blob;
  /** 16-bit PCM WAV of everything except the bass. */
  minusBass: Blob;
  sampleRate: number;
  durationMs: number;
  /** Which model produced this, so a future model upgrade can invalidate old stems. */
  model: string;
  createdAt: number;
}

export type SeparationPhase =
  | 'idle'
  | 'loading-model'
  | 'decoding'
  | 'separating'
  | 'encoding'
  | 'done'
  | 'error';

export interface SeparationProgress {
  phase: SeparationPhase;
  /** 0..1 within the current phase, or overall for 'separating'. */
  progress: number;
  message?: string;
}

/* ------------------------------------------------------------------ mixing */

/**
 * Sum any number of stems sample by sample.
 *
 * No normalisation on purpose: Demucs stems are additive, so drums+other+vocals is exactly
 * `original - bass` and stays inside the original's range. Scaling here would quietly make
 * the minus-one track softer than the original and break the A/B comparison.
 */
export function sumStems(parts: StemChannels[]): StemChannels {
  if (parts.length === 0) throw new Error('스템이 하나도 없습니다.');
  const length = parts[0].left.length;
  for (const p of parts) {
    if (p.left.length !== length || p.right.length !== length) {
      throw new Error('스템 길이가 서로 다릅니다.');
    }
  }

  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const p of parts) {
    for (let i = 0; i < length; i++) {
      left[i] += p.left[i];
      right[i] += p.right[i];
    }
  }
  return { left, right };
}

/**
 * a - b, sample by sample.
 *
 * Used by the import path: if you ran Demucs yourself and only kept `bass.wav`, the
 * minus-one track is exactly `original - bass`, so one file is enough to reconstruct both
 * modes. Demucs stems are additive and sample-aligned with the input, which is what makes
 * this exact rather than an approximation.
 */
export function subtractStems(a: StemChannels, b: StemChannels): StemChannels {
  const length = Math.min(a.left.length, b.left.length);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    left[i] = a.left[i] - b.left[i];
    right[i] = a.right[i] - b.right[i];
  }
  return { left, right };
}

/** drums + other + vocals — everything the bass player is not responsible for. */
export function buildMinusBass(result: DemucsResult): StemChannels {
  return sumStems([result.drums, result.other, result.vocals]);
}

/** Largest absolute sample, for a clipping warning in the UI. */
export function peakOf(ch: StemChannels): number {
  let peak = 0;
  for (let i = 0; i < ch.left.length; i++) {
    const l = Math.abs(ch.left[i]);
    const r = Math.abs(ch.right[i]);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak;
}

/* ------------------------------------------------------------------- WAV */

const HEADER_BYTES = 44;

/**
 * 16-bit PCM stereo WAV.
 *
 * 16-bit rather than 32-bit float halves the storage — a 4 minute song is ~42MB per stem
 * instead of ~84MB, and we keep two stems per song in IndexedDB. The quantisation floor is
 * far below anything that matters for working out a bass line by ear.
 */
export function encodeWavBuffer(ch: StemChannels, sampleRate: number): ArrayBuffer {
  const frames = Math.min(ch.left.length, ch.right.length);
  const dataBytes = frames * 2 /* channels */ * 2 /* bytes per sample */;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 2, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * 2, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    view.setInt16(offset, floatToInt16(ch.left[i]), true);
    view.setInt16(offset + 2, floatToInt16(ch.right[i]), true);
    offset += 4;
  }
  return buffer;
}

export function encodeWav(ch: StemChannels, sampleRate: number): Blob {
  return new Blob([encodeWavBuffer(ch, sampleRate)], { type: 'audio/wav' });
}

/**
 * Minimal WAV reader — only needed to verify our own encoder round-trips. Real playback
 * decoding goes through `AudioContext.decodeAudioData`, which handles every format.
 */
export function decodeWavBuffer(buffer: ArrayBuffer): { channels: StemChannels; sampleRate: number } {
  const view = new DataView(buffer);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV 파일이 아닙니다.');

  const channelCount = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== 16) throw new Error(`16비트 WAV만 읽습니다 (받은 값: ${bitsPerSample})`);

  const dataBytes = view.getUint32(40, true);
  const frames = dataBytes / (channelCount * 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  let offset = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    left[i] = int16ToFloat(view.getInt16(offset, true));
    right[i] = channelCount > 1 ? int16ToFloat(view.getInt16(offset + 2, true)) : left[i];
    offset += channelCount * 2;
  }
  return { channels: { left, right }, sampleRate };
}

function floatToInt16(v: number): number {
  // Clamp first: summed stems can theoretically overshoot, and wrapping would sound like
  // a loud click rather than the gentle distortion of a clip.
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

function int16ToFloat(v: number): number {
  return v < 0 ? v / 0x8000 : v / 0x7fff;
}
