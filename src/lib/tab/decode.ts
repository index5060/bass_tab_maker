/**
 * Stems (WAV blobs) to the mono sample arrays the analysis reads.
 *
 * Pure (wav.ts, no Web Audio), so it runs inside the analysis worker: a four-minute stem is
 * ~40MB of samples per channel, and decoding it there keeps the page responsive and saves
 * copying the result across.
 */

import { decodeWav, looksLikeWav } from '../wav';

export interface MonoAudio {
  samples: Float32Array;
  sampleRate: number;
}

/** Average the channels: where in the stereo image the bass sits says nothing about its notes. */
export function toMonoSamples(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) out[i] += channel[i];
  for (let i = 0; i < length; i++) out[i] /= channels.length;
  return out;
}

/** Throws for anything wav.ts cannot read; the caller then decodes it with Web Audio instead. */
export async function decodeStem(blob: Blob): Promise<MonoAudio> {
  const bytes = await blob.arrayBuffer();
  if (!looksLikeWav(new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength)))) {
    throw new Error('스템이 WAV가 아닙니다.');
  }
  const wav = decodeWav(bytes);
  return { samples: toMonoSamples(wav.channels), sampleRate: wav.sampleRate };
}
