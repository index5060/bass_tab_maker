/**
 * WAV reading that does not depend on the browser.
 *
 * WAV is the format this app is built around, and "a .wav file" covers far more than one
 * format: the header can carry any number of extra chunks before the audio, the samples can be
 * 8/16/24/32-bit integers or 32/64-bit floats, or compressed (µ-law, A-law, ADPCM), and big
 * files use the RF64 container. Browsers decode only some of that, and which part differs from
 * browser to browser. Measured in Chromium: 64-bit float and both ADPCM flavours fail outright
 * ("Unable to decode audio data"), for both decoding and playback.
 *
 * So WAV is read here, by walking the chunks properly, for every format above. Nothing in this
 * file touches a browser API, which keeps it testable against reference output (ffmpeg's).
 */

export interface WavInfo {
  container: 'RIFF' | 'RF64';
  /** The actual sample format, with WAVE_FORMAT_EXTENSIBLE resolved to its sub-format. */
  formatCode: number;
  extensible: boolean;
  /** Human-readable, for messages: "PCM 24비트", "IEEE float 64비트", "IMA ADPCM" … */
  formatName: string;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** Byte offset of the first sample, and how many bytes of samples follow. */
  dataOffset: number;
  dataBytes: number;
  /** Sample frames per compressed block (ADPCM only). */
  samplesPerBlock: number;
  /** Total frames as declared by a 'fact' chunk, when there is one. */
  factFrames: number | null;
  /** MS ADPCM predictor coefficient pairs. */
  msCoefficients: Array<[number, number]>;
}

/** Sample arrays always own a plain ArrayBuffer, which Web Audio and Blob both require. */
export type Samples = Float32Array<ArrayBuffer>;

export interface DecodedWav {
  sampleRate: number;
  /** One array per channel, -1..1. */
  channels: Samples[];
  info: WavInfo;
}

/** A well-formed WAV in a format this reader does not decode (the browser may still). */
export class UnsupportedWavError extends Error {}

const FORMAT_PCM = 0x0001;
const FORMAT_MS_ADPCM = 0x0002;
const FORMAT_FLOAT = 0x0003;
const FORMAT_ALAW = 0x0006;
const FORMAT_MULAW = 0x0007;
const FORMAT_IMA_ADPCM = 0x0011;
const FORMAT_EXTENSIBLE = 0xfffe;

const KNOWN_FORMAT_NAMES: Record<number, string> = {
  [FORMAT_MS_ADPCM]: 'MS ADPCM',
  [FORMAT_ALAW]: 'A-law',
  [FORMAT_MULAW]: 'µ-law',
  [FORMAT_IMA_ADPCM]: 'IMA ADPCM',
  0x0031: 'GSM 6.10',
  0x0055: 'MP3',
  0x0161: 'WMA',
};

/** True when the bytes start like a WAV file, whatever the file is called. */
export function looksLikeWav(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const tag = (o: number) => String.fromCharCode(head[o], head[o + 1], head[o + 2], head[o + 3]);
  return (tag(0) === 'RIFF' || tag(0) === 'RF64') && tag(8) === 'WAVE';
}

/**
 * Walk the chunks and describe the audio. Needs the bytes up to the start of the audio, not
 * the whole file, so a header can be read from a slice.
 */
export function readWavInfo(buffer: ArrayBuffer, totalBytes = buffer.byteLength): WavInfo {
  const bytes = new Uint8Array(buffer);
  if (!looksLikeWav(bytes)) throw new Error('WAV 파일이 아닙니다 (RIFF/WAVE 머리글이 없음).');
  const view = new DataView(buffer);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  const container = tag(0) as 'RIFF' | 'RF64';

  let fmt: Omit<WavInfo, 'container' | 'dataOffset' | 'dataBytes' | 'factFrames'> | null = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let factFrames: number | null = null;
  let rf64DataBytes: number | null = null;

  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;

    if (id === 'ds64' && body + 24 <= bytes.length) {
      // RF64 keeps the real 64-bit sizes here; the 32-bit fields elsewhere say 0xFFFFFFFF.
      rf64DataBytes = Number(view.getBigUint64(body + 8, true));
    } else if (id === 'fmt ' && body + 16 <= bytes.length) {
      fmt = parseFmt(view, body, size);
    } else if (id === 'fact' && body + 4 <= bytes.length) {
      factFrames = view.getUint32(body, true);
    } else if (id === 'data') {
      dataOffset = body;
      // Recorders that were cut off, and streaming writers, leave the size at 0 or 0xFFFFFFFF.
      // The audio then simply runs to the end of the file.
      const remaining = totalBytes - body;
      const declared = container === 'RF64' && size === 0xffffffff && rf64DataBytes !== null ? rf64DataBytes : size;
      dataBytes = declared === 0 || declared === 0xffffffff || declared > remaining ? remaining : declared;
      if (fmt) break;
      // 'fmt ' after 'data' is legal, if rare: skip the audio and keep looking.
      if (declared === 0 || declared === 0xffffffff || declared > remaining) break;
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte.
    const next = body + size + (size & 1);
    if (next <= pos) break;
    pos = next;
  }

  if (!fmt) throw new Error('WAV 머리글에 형식 정보(fmt)가 없습니다. 파일이 손상됐을 수 있습니다.');
  if (dataOffset < 0) throw new Error('WAV 파일에 오디오 데이터(data)가 없습니다. 파일이 손상됐을 수 있습니다.');
  if (fmt.channels < 1 || fmt.sampleRate < 1 || fmt.blockAlign < 1) {
    throw new Error('WAV 머리글 값이 올바르지 않습니다 (채널 수나 샘플레이트가 0).');
  }
  return { container, ...fmt, dataOffset, dataBytes, factFrames };
}

function parseFmt(view: DataView, at: number, size: number) {
  let formatCode = view.getUint16(at, true);
  const channels = view.getUint16(at + 2, true);
  const sampleRate = view.getUint32(at + 4, true);
  const blockAlign = view.getUint16(at + 12, true);
  const bitsPerSample = view.getUint16(at + 14, true);
  const cbSize = size >= 18 ? view.getUint16(at + 16, true) : 0;

  let extensible = false;
  if (formatCode === FORMAT_EXTENSIBLE && size >= 40) {
    extensible = true;
    // The first two bytes of the sub-format GUID are the classic format code.
    formatCode = view.getUint16(at + 24, true);
  }

  let samplesPerBlock = 0;
  const msCoefficients: Array<[number, number]> = [];
  if ((formatCode === FORMAT_IMA_ADPCM || formatCode === FORMAT_MS_ADPCM) && cbSize >= 2) {
    samplesPerBlock = view.getUint16(at + 18, true);
  }
  if (formatCode === FORMAT_MS_ADPCM && cbSize >= 4) {
    const count = view.getUint16(at + 20, true);
    for (let i = 0; i < count && at + 26 + i * 4 <= view.byteLength; i++) {
      msCoefficients.push([view.getInt16(at + 22 + i * 4, true), view.getInt16(at + 24 + i * 4, true)]);
    }
  }

  return {
    formatCode,
    extensible,
    formatName: formatName(formatCode, bitsPerSample),
    channels,
    sampleRate,
    bitsPerSample,
    blockAlign,
    samplesPerBlock,
    msCoefficients,
  };
}

function formatName(code: number, bits: number): string {
  if (code === FORMAT_PCM) return `PCM ${bits}비트`;
  if (code === FORMAT_FLOAT) return `float ${bits}비트`;
  return KNOWN_FORMAT_NAMES[code] ?? `형식 코드 0x${code.toString(16).padStart(4, '0')}`;
}

/* ----------------------------------------------------------------- decode */

export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const info = readWavInfo(buffer);
  const data = new DataView(buffer, info.dataOffset, Math.min(info.dataBytes, buffer.byteLength - info.dataOffset));
  let channels: Samples[];

  switch (info.formatCode) {
    case FORMAT_PCM:
    case FORMAT_FLOAT:
    case FORMAT_MULAW:
    case FORMAT_ALAW:
      channels = decodeLinear(data, info);
      break;
    case FORMAT_IMA_ADPCM:
      channels = decodeImaAdpcm(data, info);
      break;
    case FORMAT_MS_ADPCM:
      channels = decodeMsAdpcm(data, info);
      break;
    default:
      throw new UnsupportedWavError(`${info.formatName} WAV는 직접 읽지 못합니다.`);
  }
  return { sampleRate: info.sampleRate, channels, info };
}

/** Every format where each sample is stored on its own: PCM, float, µ-law, A-law. */
function decodeLinear(data: DataView, info: WavInfo): Samples[] {
  const ch = info.channels;
  // The container size, not bitsPerSample: 20-bit audio lives in 3-byte slots.
  const width = Math.floor(info.blockAlign / ch);
  const frames = Math.floor(data.byteLength / info.blockAlign);
  const out = Array.from({ length: ch }, () => new Float32Array(frames));
  const read = sampleReader(info.formatCode, width, info.bitsPerSample);

  for (let f = 0; f < frames; f++) {
    const base = f * info.blockAlign;
    for (let c = 0; c < ch; c++) out[c][f] = read(data, base + c * width);
  }
  return out;
}

function sampleReader(code: number, width: number, bits: number): (v: DataView, o: number) => number {
  if (code === FORMAT_FLOAT) {
    if (width === 4) return (v, o) => v.getFloat32(o, true);
    if (width === 8) return (v, o) => v.getFloat64(o, true);
  }
  if (code === FORMAT_MULAW && width === 1) return (v, o) => MULAW[v.getUint8(o)];
  if (code === FORMAT_ALAW && width === 1) return (v, o) => ALAW[v.getUint8(o)];
  if (code === FORMAT_PCM) {
    // 8-bit WAV is the one unsigned PCM width.
    if (width === 1) return (v, o) => (v.getUint8(o) - 128) / 128;
    if (width === 2) return (v, o) => v.getInt16(o, true) / 32768;
    if (width === 3) {
      return (v, o) => ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608);
    }
    if (width === 4) return (v, o) => v.getInt32(o, true) / 2147483648;
  }
  throw new UnsupportedWavError(`${formatName(code, bits)} (${width * 8}비트 칸) WAV는 직접 읽지 못합니다.`);
}

/* G.711 tables: each 8-bit code maps to a 14/13-bit linear value. */
const MULAW = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const exponent = (u >> 4) & 7;
    const mantissa = u & 15;
    const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
    t[i] = (u & 0x80 ? -magnitude : magnitude) / 32768;
  }
  return t;
})();

const ALAW = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const a = i ^ 0x55;
    const exponent = (a >> 4) & 7;
    const mantissa = a & 15;
    let magnitude = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
    if (!(a & 0x80)) magnitude = -magnitude;
    t[i] = magnitude / 32768;
  }
  return t;
})();

/* ------------------------------------------------------------- IMA ADPCM */

const IMA_STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
  449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
  9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const IMA_INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/**
 * IMA/DVI ADPCM as WAV stores it: per block, a 4-byte header per channel (first sample and
 * step index), then 4-byte groups of eight 4-bit codes per channel, low nibble first.
 */
function decodeImaAdpcm(data: DataView, info: WavInfo): Samples[] {
  const ch = info.channels;
  const block = info.blockAlign;
  const perBlock = info.samplesPerBlock || ((block - 4 * ch) * 8) / (4 * ch) + 1;
  const blocks = Math.ceil(data.byteLength / block);
  const frames = Math.min(info.factFrames ?? Infinity, blocks * perBlock);
  const out = Array.from({ length: ch }, () => new Float32Array(frames));

  let frame = 0;
  for (let b = 0; b < blocks && frame < frames; b++) {
    const start = b * block;
    const end = Math.min(start + block, data.byteLength);
    if (start + 4 * ch > end) break;

    const predictor: number[] = [];
    const index: number[] = [];
    for (let c = 0; c < ch; c++) {
      predictor[c] = data.getInt16(start + c * 4, true);
      index[c] = Math.min(88, Math.max(0, data.getUint8(start + c * 4 + 2)));
      out[c][frame] = predictor[c] / 32768;
    }
    let decoded = 1;

    let pos = start + 4 * ch;
    while (pos + 4 * ch <= end && decoded < perBlock) {
      for (let c = 0; c < ch; c++) {
        for (let k = 0; k < 8; k++) {
          const byte = data.getUint8(pos + c * 4 + (k >> 1));
          const nibble = k & 1 ? byte >> 4 : byte & 15;
          const step = IMA_STEPS[index[c]];
          let diff = step >> 3;
          if (nibble & 1) diff += step >> 2;
          if (nibble & 2) diff += step >> 1;
          if (nibble & 4) diff += step;
          predictor[c] = Math.max(-32768, Math.min(32767, predictor[c] + (nibble & 8 ? -diff : diff)));
          index[c] = Math.max(0, Math.min(88, index[c] + IMA_INDEX_SHIFT[nibble]));
          const at = frame + decoded + k;
          if (decoded + k < perBlock && at < frames) out[c][at] = predictor[c] / 32768;
        }
      }
      decoded += 8;
      pos += 4 * ch;
    }
    frame += Math.min(perBlock, decoded);
  }
  return frame < frames ? out.map((a) => a.slice(0, frame)) : out;
}

/* -------------------------------------------------------------- MS ADPCM */

const MS_ADAPTATION = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const MS_DEFAULT_COEFFICIENTS: Array<[number, number]> = [
  [256, 0],
  [512, -256],
  [0, 0],
  [192, 64],
  [240, 0],
  [460, -208],
  [392, -232],
];

/**
 * Microsoft ADPCM: per block, a predictor index, a step and two seed samples per channel,
 * then 4-bit codes, high nibble first, alternating channels.
 */
function decodeMsAdpcm(data: DataView, info: WavInfo): Samples[] {
  const ch = info.channels;
  const block = info.blockAlign;
  const coefficients = info.msCoefficients.length ? info.msCoefficients : MS_DEFAULT_COEFFICIENTS;
  const header = 7 * ch;
  const perBlock = info.samplesPerBlock || ((block - header) * 2) / ch + 2;
  const blocks = Math.ceil(data.byteLength / block);
  const frames = Math.min(info.factFrames ?? Infinity, blocks * perBlock);
  const out = Array.from({ length: ch }, () => new Float32Array(frames));

  let frame = 0;
  for (let b = 0; b < blocks && frame < frames; b++) {
    const start = b * block;
    const end = Math.min(start + block, data.byteLength);
    if (start + header > end) break;

    const coef: Array<[number, number]> = [];
    const delta: number[] = [];
    const s1: number[] = [];
    const s2: number[] = [];
    for (let c = 0; c < ch; c++) {
      coef[c] = coefficients[Math.min(coefficients.length - 1, data.getUint8(start + c))];
      delta[c] = data.getInt16(start + ch + c * 2, true);
      s1[c] = data.getInt16(start + 3 * ch + c * 2, true);
      s2[c] = data.getInt16(start + 5 * ch + c * 2, true);
    }
    // The seeds come out oldest first.
    for (let c = 0; c < ch; c++) {
      if (frame < frames) out[c][frame] = s2[c] / 32768;
      if (frame + 1 < frames) out[c][frame + 1] = s1[c] / 32768;
    }

    let produced = 2;
    let channel = 0;
    for (let pos = start + header; pos < end && produced < perBlock; pos++) {
      const byte = data.getUint8(pos);
      for (const nibble of [byte >> 4, byte & 15]) {
        const c = channel;
        const signed = nibble >= 8 ? nibble - 16 : nibble;
        const predicted = (s1[c] * coef[c][0] + s2[c] * coef[c][1]) >> 8;
        const sample = Math.max(-32768, Math.min(32767, predicted + signed * delta[c]));
        s2[c] = s1[c];
        s1[c] = sample;
        delta[c] = Math.max(16, (MS_ADAPTATION[nibble] * delta[c]) >> 8);
        const at = frame + produced;
        if (at < frames) out[c][at] = sample / 32768;
        channel = (channel + 1) % ch;
        if (channel === 0) produced++;
      }
    }
    frame += Math.min(perBlock, produced);
  }
  return frame < frames ? out.map((a) => a.slice(0, frame)) : out;
}

/* ------------------------------------------------------------- channels */

/**
 * Any channel count down to the stereo pair the rest of the app works in.
 *
 * Surround WAVs follow the WAVE_FORMAT_EXTENSIBLE speaker order (L R C LFE …). The bass is
 * often in the centre and LFE channels there, so those are folded into both sides rather
 * than dropped.
 */
export function toStereo(channels: Samples[]): { left: Samples; right: Samples } {
  if (channels.length === 1) return { left: channels[0], right: channels[0] };
  if (channels.length === 2) return { left: channels[0], right: channels[1] };
  const frames = channels[0].length;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const shared = channels.slice(2, 4); // centre, LFE
  const rest = channels.slice(4);
  for (let i = 0; i < frames; i++) {
    let l = channels[0][i];
    let r = channels[1][i];
    for (const s of shared) {
      l += s[i] * 0.707;
      r += s[i] * 0.707;
    }
    rest.forEach((s, k) => {
      if (k % 2 === 0) l += s[i] * 0.707;
      else r += s[i] * 0.707;
    });
    left[i] = l;
    right[i] = r;
  }
  return { left, right };
}
