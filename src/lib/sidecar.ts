/**
 * Client for the local separation sidecar.
 *
 * The browser separator runs a fixed, quantised model with no knobs — no model choice, no
 * shift averaging, no overlap control, no GPU. Those are precisely the settings that decide
 * whether a bass stem comes out clean or choppy. The sidecar is a small local process that
 * runs the real demucs and exposes all of them, without turning the web app into a desktop
 * program.
 *
 * Everything here degrades quietly: if the sidecar is not running, `probeSidecar` reports it
 * and the app carries on with browser separation. Nothing in the rest of the app knows or
 * cares which path produced a StemSet.
 */

import { decodeToModelRate, MODEL_SAMPLE_RATE, type ProgressFn, type Separator } from './separator';
import { encodeWav, type StemSet } from './stems';
import { readWavInfo } from './wav';

export const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:8765';

export interface SidecarInfo {
  /** The process answered. */
  reachable: boolean;
  /** It answered AND demucs is importable there. */
  ready: boolean;
  demucs: string | null;
  /** Version of basic-pitch when installed there — unlocks AI transcription of the stem. */
  basicPitch: string | null;
  /** Version of yt-dlp when installed there — unlocks "YouTube link -> audio". */
  ytdlp: string | null;
  /**
   * yt-dlp's YouTube challenge solver (the yt-dlp-ejs package). Without it most videos fail
   * with a signature error, so the UI warns up front rather than after the failure.
   */
  ytdlpEjs: boolean;
  /**
   * Whether demucs there can read compressed audio. null for a sidecar too old to say, which
   * is treated as "yes" — that is how it always behaved.
   */
  ffmpeg: boolean | null;
  /** "cuda (RTX 4070)" / "cpu" / "mps" — the difference between minutes and tens of them. */
  device: string;
  models: string[];
  /** Why it is not usable, when it is not. */
  reason: string | null;
}

export interface SidecarSettings {
  model: string;
  /** Shift-and-average passes. Each one multiplies the runtime. */
  shifts: number;
  /** Segment overlap, 0-0.9. Higher smooths the seams between processing chunks. */
  overlap: number;
}

export const DEFAULT_SIDECAR_SETTINGS: SidecarSettings = {
  model: 'htdemucs_ft',
  shifts: 1,
  overlap: 0.25,
};

/* ---------------------------------------------------------------- probing */

/**
 * Ask whether the sidecar is there.
 *
 * Deliberately short-timeout and never throws: this runs on page load, and a missing sidecar
 * is the normal case, not an error.
 */
export async function probeSidecar(
  baseUrl: string = DEFAULT_SIDECAR_URL,
  timeoutMs = 1500,
): Promise<SidecarInfo> {
  const absent = (reason: string): SidecarInfo => ({
    reachable: false,
    ready: false,
    demucs: null,
    basicPitch: null,
    ytdlp: null,
    ytdlpEjs: false,
    ffmpeg: null,
    device: 'unknown',
    models: [],
    reason,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!res.ok) return absent(`사이드카가 HTTP ${res.status}로 응답했습니다.`);
    const body = (await res.json()) as {
      name?: string;
      demucs?: string | null;
      demucsInstalled?: boolean;
      basicPitch?: string | null;
      ytdlp?: string | null;
      ytdlpEjs?: boolean;
      ffmpeg?: boolean;
      device?: string;
      models?: string[];
    };
    if (body.name !== 'bass-practice-sidecar') {
      return absent('그 포트에 다른 프로그램이 떠 있습니다.');
    }
    return {
      reachable: true,
      ready: body.demucsInstalled === true,
      demucs: body.demucs ?? null,
      basicPitch: body.basicPitch ?? null,
      ytdlp: body.ytdlp ?? null,
      ytdlpEjs: body.ytdlpEjs === true,
      ffmpeg: typeof body.ffmpeg === 'boolean' ? body.ffmpeg : null,
      device: body.device ?? 'unknown',
      models: body.models ?? [],
      reason: body.demucsInstalled
        ? null
        : '사이드카는 떠 있는데 demucs가 없습니다. "pip install demucs"를 실행하세요.',
    };
  } catch {
    return absent('사이드카가 실행 중이 아닙니다.');
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- separation */

interface JobStatus {
  state: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
  error: string | null;
  hasNoBass: boolean;
}

/**
 * Read sample rate and duration from the WAV header — no need to decode 86MB. Walks the chunks
 * rather than assuming the 44-byte layout, which any metadata chunk breaks.
 */
async function readWavDuration(blob: Blob): Promise<{ sampleRate: number; durationMs: number }> {
  const head = await blob.slice(0, Math.min(blob.size, 1 << 20)).arrayBuffer();
  const info = readWavInfo(head, blob.size);
  const bytesPerSecond = info.sampleRate * info.blockAlign;
  return {
    sampleRate: info.sampleRate,
    durationMs: bytesPerSecond > 0 ? (info.dataBytes / bytesPerSecond) * 1000 : 0,
  };
}

/**
 * Whether audio has to become WAV in the browser before the sidecar can separate it.
 *
 * demucs reads everything but WAV through ffmpeg. A YouTube download is m4a, so on a machine
 * without ffmpeg the sidecar would fail on exactly the files this app now fetches for you —
 * while the browser, which decodes m4a natively, could have handed it a WAV all along.
 */
export function needsWavForSidecar(source: Blob, ffmpeg: boolean | null): boolean {
  return ffmpeg === false && guessExtension(source) !== 'wav';
}

export class SidecarSeparator implements Separator {
  // Declared as fields rather than constructor parameter properties: the project builds with
  // `erasableSyntaxOnly`, which rules out any TypeScript that emits real code.
  private readonly settings: SidecarSettings;
  private readonly baseUrl: string;
  private readonly ffmpeg: boolean | null;

  constructor(
    settings: SidecarSettings = DEFAULT_SIDECAR_SETTINGS,
    baseUrl: string = DEFAULT_SIDECAR_URL,
    ffmpeg: boolean | null = null,
  ) {
    this.settings = settings;
    this.baseUrl = baseUrl;
    this.ffmpeg = ffmpeg;
  }

  async separate(original: Blob, onProgress: ProgressFn): Promise<StemSet> {
    let source = original;
    if (needsWavForSidecar(original, this.ffmpeg)) {
      onProgress({ phase: 'decoding', progress: 0, message: 'WAV로 변환 중 (사이드카에 ffmpeg 없음)' });
      const { channels } = await decodeToModelRate(original);
      source = new File([encodeWav(channels, MODEL_SAMPLE_RATE)], 'input.wav', { type: 'audio/wav' });
    }
    onProgress({ phase: 'decoding', progress: 0, message: '사이드카로 보내는 중' });

    const ext = guessExtension(source);
    const query = new URLSearchParams({
      model: this.settings.model,
      shifts: String(this.settings.shifts),
      overlap: String(this.settings.overlap),
      ext,
    });

    const submitted = await fetch(`${this.baseUrl}/separate?${query}`, {
      method: 'POST',
      body: source,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!submitted.ok) {
      const detail = await submitted.json().catch(() => ({ error: `HTTP ${submitted.status}` }));
      throw new Error(String(detail.error ?? `HTTP ${submitted.status}`));
    }
    const { id } = (await submitted.json()) as { id: string };

    // Poll rather than hold one long request open: separation can run for many minutes and a
    // stalled connection tells you nothing, while a poll gives a live percentage.
    let status: JobStatus | null = null;
    for (;;) {
      await sleep(700);
      const res = await fetch(`${this.baseUrl}/jobs/${id}`);
      if (!res.ok) throw new Error(`작업 상태를 읽지 못했습니다 (HTTP ${res.status}).`);
      status = (await res.json()) as JobStatus;

      if (status.state === 'error') {
        throw new Error(status.error ?? '사이드카 분리에 실패했습니다.');
      }
      onProgress({
        phase: status.state === 'queued' ? 'loading-model' : 'separating',
        progress: status.progress,
        message: status.message || this.settings.model,
      });
      if (status.state === 'done') break;
    }

    onProgress({ phase: 'encoding', progress: 0, message: '스템 받는 중' });
    const bass = await fetchBlob(`${this.baseUrl}/jobs/${id}/bass`);
    // demucs produced the companion track itself, so use it rather than subtracting — it is
    // the model's own output, not an arithmetic reconstruction.
    const minusBass = status.hasNoBass
      ? await fetchBlob(`${this.baseUrl}/jobs/${id}/no_bass`)
      : null;
    if (!minusBass) throw new Error('사이드카가 no_bass.wav를 돌려주지 않았습니다.');

    const info = await readWavDuration(bass);

    // Tidy up the temp directory rather than leaving hundreds of MB behind per run.
    void fetch(`${this.baseUrl}/jobs/${id}`, { method: 'DELETE' }).catch(() => undefined);

    onProgress({ phase: 'done', progress: 1 });
    return {
      bass,
      minusBass,
      sampleRate: info.sampleRate || 44100,
      durationMs: info.durationMs,
      model: `${this.settings.model} (사이드카, shifts ${this.settings.shifts})`,
      createdAt: Date.now(),
    };
  }
}

/* ----------------------------------------------------------- transcription */

export interface SidecarNote {
  midi: number;
  startMs: number;
  endMs: number;
  confidence: number;
}

/**
 * Run basic-pitch on the sidecar and get note events back.
 *
 * This is the Songsterr-style "AI draft" path: a trained onset+pitch network instead of the
 * built-in autocorrelation detector. The browser keeps everything downstream — grid fitting,
 * quantisation, fretboard mapping — so only the ears changed, not the writing.
 */
export async function transcribeViaSidecar(
  source: Blob,
  baseUrl: string = DEFAULT_SIDECAR_URL,
  onMessage?: (message: string) => void,
): Promise<SidecarNote[]> {
  const submitted = await fetch(`${baseUrl}/transcribe?ext=${guessExtension(source)}`, {
    method: 'POST',
    body: source,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!submitted.ok) {
    const detail = await submitted.json().catch(() => ({ error: `HTTP ${submitted.status}` }));
    throw new Error(String(detail.error ?? `HTTP ${submitted.status}`));
  }
  const { id } = (await submitted.json()) as { id: string };

  for (;;) {
    await sleep(600);
    const res = await fetch(`${baseUrl}/jobs/${id}`);
    if (!res.ok) throw new Error(`작업 상태를 읽지 못했습니다 (HTTP ${res.status}).`);
    const status = (await res.json()) as JobStatus;
    if (status.state === 'error') throw new Error(status.error ?? 'AI 채보에 실패했습니다.');
    onMessage?.(status.message || 'basic-pitch');
    if (status.state === 'done') break;
  }

  const notesRes = await fetch(`${baseUrl}/jobs/${id}/notes`);
  if (!notesRes.ok) throw new Error(`채보 결과를 받지 못했습니다 (HTTP ${notesRes.status}).`);
  const body = (await notesRes.json()) as { notes: SidecarNote[] };
  void fetch(`${baseUrl}/jobs/${id}`, { method: 'DELETE' }).catch(() => undefined);
  return body.notes;
}

/* ----------------------------------------------------------------- youtube */

export interface YouTubeDownload {
  /** The audio, named after the video so it reads sensibly anywhere a filename shows. */
  file: File;
  title: string;
  artist: string;
  durationSec: number | null;
  /** The canonical single-video URL the sidecar actually fetched. */
  url: string;
}

interface YouTubeMeta {
  title: string;
  artist: string;
  durationSec: number | null;
  url: string;
  ext: string;
  contentType: string;
}

/**
 * Have the sidecar fetch a YouTube video's audio with yt-dlp and hand the file back.
 *
 * It has to be the sidecar: a page cannot read YouTube's media streams (no CORS, and the
 * stream URLs only resolve after running YouTube's own player JavaScript), which is exactly
 * the problem yt-dlp exists to solve.
 */
export async function downloadFromYouTube(
  url: string,
  onProgress?: (progress: number, message: string) => void,
  baseUrl: string = DEFAULT_SIDECAR_URL,
): Promise<YouTubeDownload> {
  const submitted = await fetch(`${baseUrl}/youtube`, {
    method: 'POST',
    body: JSON.stringify({ url }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!submitted.ok) {
    const detail = await submitted.json().catch(() => ({ error: `HTTP ${submitted.status}` }));
    throw new Error(String(detail.error ?? `HTTP ${submitted.status}`));
  }
  const { id } = (await submitted.json()) as { id: string };

  let meta: YouTubeMeta | null = null;
  for (;;) {
    await sleep(500);
    const res = await fetch(`${baseUrl}/jobs/${id}`);
    if (!res.ok) throw new Error(`작업 상태를 읽지 못했습니다 (HTTP ${res.status}).`);
    const status = (await res.json()) as JobStatus & { meta: YouTubeMeta | null };
    if (status.state === 'error') throw new Error(status.error ?? 'YouTube에서 받지 못했습니다.');
    onProgress?.(status.progress, status.message || 'yt-dlp');
    if (status.state === 'done') {
      meta = status.meta;
      break;
    }
  }
  if (!meta) throw new Error('사이드카가 영상 정보를 돌려주지 않았습니다.');

  const res = await fetch(`${baseUrl}/jobs/${id}/audio`);
  if (!res.ok) throw new Error(`오디오를 받지 못했습니다 (HTTP ${res.status}).`);
  const bytes = await res.blob();
  void fetch(`${baseUrl}/jobs/${id}`, { method: 'DELETE' }).catch(() => undefined);

  return {
    // The extension matters downstream: guessExtension reads it to tell the sidecar what
    // container it is getting, and it is what a saved copy will be called.
    file: new File([bytes], `${fileSafe(meta.title) || 'youtube'}.${meta.ext}`, {
      type: meta.contentType,
    }),
    title: meta.title,
    artist: meta.artist,
    durationSec: meta.durationSec,
    url: meta.url,
  };
}

/** Strip what Windows refuses in a filename, and keep it a sane length. */
export function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80).trim();
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`스템을 받지 못했습니다 (HTTP ${res.status}).`);
  return res.blob();
}

function guessExtension(blob: Blob): string {
  const type = (blob as File).name?.split('.').pop() ?? '';
  if (/^[a-z0-9]{2,4}$/i.test(type)) return type.toLowerCase();
  const mime = blob.type || '';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'mp3';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
