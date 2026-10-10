/**
 * Get a picked audio file into a shape every part of the app can use.
 *
 * Everything downstream — the <audio> player, the browser separator, the sidecar, the
 * transcriber — has its own idea of which WAVs it can read, and a WAV it cannot read used to
 * fail somewhere in the middle, often silently. This settles it once, at the door: a WAV that
 * any browser plays is kept byte for byte; any other WAV is decoded here (see wav.ts) and
 * stored as plain 16-bit PCM. Non-WAV files pass through unchanged.
 */

import { encodeWav } from './stems';
import {
  decodeWav,
  looksLikeWav,
  readWavInfo,
  toStereo,
  UnsupportedWavError,
  type Samples,
  type WavInfo,
} from './wav';

/**
 * The file picker filter. Extensions are listed as well as the MIME wildcards because the
 * operating system decides what "audio/*" means: on a Windows machine whose registry has lost
 * or changed the content type for .wav, the dialog quietly stops offering WAV files.
 */
export const AUDIO_FILE_ACCEPT =
  'audio/*,video/*,.wav,.wave,.mp3,.m4a,.aac,.flac,.ogg,.oga,.opus,.webm,.mp4';

export interface PreparedAudio {
  file: File;
  /** Set when the file was converted, saying from what. */
  note: string | null;
}

export interface PrepareDeps {
  /** Browser decoding, for WAV formats wav.ts does not read. */
  decodeWithBrowser: (bytes: ArrayBuffer) => Promise<{ sampleRate: number; channels: Samples[] }>;
}

const browserDeps: PrepareDeps = {
  async decodeWithBrowser(bytes) {
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(bytes);
      return {
        sampleRate: decoded.sampleRate,
        channels: Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c)),
      };
    } finally {
      void ctx.close();
    }
  },
};

/**
 * Plain PCM at 16 or 24 bits, mono or stereo, in an ordinary RIFF file. Every browser plays
 * and decodes that; it is also what nearly every DAW, recorder and converter writes by default.
 */
export function isUniversalWav(info: WavInfo): boolean {
  return (
    info.container === 'RIFF' &&
    info.formatCode === 1 &&
    (info.bitsPerSample === 16 || info.bitsPerSample === 24) &&
    info.blockAlign === info.channels * (info.bitsPerSample / 8) &&
    info.channels <= 2
  );
}

export async function prepareAudioFile(file: File, deps: PrepareDeps = browserDeps): Promise<PreparedAudio> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  // Decided by content, not by name: a WAV called ".WAV", ".wave" or with no extension at all
  // is still a WAV, and an mp3 renamed to .wav is not.
  if (!looksLikeWav(head)) return { file, note: null };

  const bytes = await file.arrayBuffer();
  const info = readWavInfo(bytes);
  const name = /\.wave?$/i.test(file.name) ? file.name : `${file.name.replace(/\.[^.]+$/, '') || 'audio'}.wav`;

  if (isUniversalWav(info)) {
    // Same bytes; only make sure the name and type say WAV, since Windows sometimes hands the
    // page an empty type for it.
    return {
      file: file.type === 'audio/wav' && name === file.name ? file : new File([file], name, { type: 'audio/wav' }),
      note: null,
    };
  }

  let decoded: { sampleRate: number; channels: Samples[] };
  try {
    decoded = decodeWav(bytes);
  } catch (e) {
    if (!(e instanceof UnsupportedWavError)) throw e;
    try {
      decoded = await deps.decodeWithBrowser(bytes.slice(0));
    } catch {
      throw new Error(
        `이 WAV는 ${info.formatName} 형식이라 읽을 수 없습니다. 녹음/편집 프로그램에서 ` +
          `"WAV (PCM 16비트 또는 24비트)"로 다시 저장해 주세요.`,
      );
    }
  }
  if (decoded.channels.length === 0 || decoded.channels[0].length === 0) {
    throw new Error('WAV 파일에 소리가 들어 있지 않습니다 (길이 0).');
  }

  const converted = encodeWav(toStereo(decoded.channels), decoded.sampleRate);
  return {
    file: new File([converted], name, { type: 'audio/wav' }),
    note: `${describe(info)} WAV는 브라우저에 따라 재생되지 않아 16비트 PCM으로 바꿔 저장했습니다.`,
  };
}

function describe(info: WavInfo): string {
  const layout = info.channels > 2 ? ` ${info.channels}채널` : '';
  return `${info.formatName}${layout}`;
}
