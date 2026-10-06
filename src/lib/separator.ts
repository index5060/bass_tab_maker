/**
 * Stem separation — the part that has no heavy dependencies.
 *
 * Everything ONNX-shaped lives in `demucsBackend.ts` and is only ever loaded on demand.
 * That split is deliberate: Vite resolves the specifier of a dynamic `import()` at transform
 * time, so a module that merely *mentions* `onnxruntime-web` fails to transform when that
 * package is missing — and because this module sits on App's static import graph, that failure
 * used to blank the whole page. An optional feature must not be able to take down the app.
 *
 * So this file stays importable with nothing but the browser's own audio APIs, and the
 * "import a bass stem I separated elsewhere" path keeps working even if the ONNX packages
 * were never installed.
 */

import {
  subtractStems,
  encodeWav,
  peakOf,
  type StemSet,
  type StemChannels,
  type SeparationProgress,
} from './stems';

/** HTDemucs was trained at 44.1kHz; anything else has to be resampled first. */
export const MODEL_SAMPLE_RATE = 44100;

export type ProgressFn = (p: SeparationProgress) => void;

export interface Separator {
  separate(source: Blob, onProgress: ProgressFn): Promise<StemSet>;
}

/* --------------------------------------------------------------- isolation */

export interface IsolationStatus {
  supported: boolean;
  reason: string | null;
}

/**
 * How separation will actually run here.
 *
 * Cross-origin isolation is NOT a hard requirement, which is worth spelling out because the
 * first version of this file treated it as one and refused to run at all without it.
 * onnxruntime-web itself degrades: its own code does `numThreads > 1 && !multiThreadSupported
 * -> numThreads = 1`, and a single-threaded session needs no SharedArrayBuffer. And the
 * WebGPU execution provider — which demucs-web asks for first — never touches SAB in the
 * first place, so on a WebGPU-capable browser isolation is irrelevant to speed.
 *
 * So isolation only decides whether the *CPU fallback* gets to use multiple threads.
 */
export type SeparationMode = 'webgpu' | 'wasm-threaded' | 'wasm-single';

export interface SeparationCapability {
  /** False only when the browser can run neither WebGPU nor WASM at all. */
  canRun: boolean;
  mode: SeparationMode;
  webgpu: boolean;
  isolated: boolean;
  /** One line on what to expect, shown next to the run button. */
  note: string;
}

export async function detectCapability(): Promise<SeparationCapability> {
  const isolated = self.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';

  let webgpu = false;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu) webgpu = (await gpu.requestAdapter()) !== null;
  } catch {
    webgpu = false;
  }

  const mode: SeparationMode = webgpu ? 'webgpu' : isolated ? 'wasm-threaded' : 'wasm-single';

  const note =
    mode === 'webgpu'
      ? 'WebGPU 가속으로 돌아갑니다. 가장 빠른 경로입니다.'
      : mode === 'wasm-threaded'
        ? 'CPU 멀티스레드로 돌아갑니다.'
        : 'CPU 단일 스레드로 돌아갑니다 — 느립니다. ' +
          'cross-origin isolation이 꺼져 있어 멀티스레드를 못 씁니다.';

  return { canRun: true, mode, webgpu, isolated, note };
}

/**
 * SharedArrayBuffer — and therefore onnxruntime-web — is only handed out on a
 * cross-origin-isolated page. Checking up front turns a confusing mid-run crash into a
 * message someone can act on. Deliberately dependency-free so the UI can call it on render.
 */
export function checkIsolation(): IsolationStatus {
  if (typeof SharedArrayBuffer === 'undefined') {
    return { supported: false, reason: 'SharedArrayBuffer를 쓸 수 없습니다. COOP/COEP 헤더가 필요합니다.' };
  }
  if (!self.crossOriginIsolated) {
    return { supported: false, reason: 'cross-origin isolation이 꺼져 있습니다. dev 서버를 재시작해 보세요.' };
  }
  return { supported: true, reason: null };
}

export interface IsolationDiagnosis {
  crossOriginIsolated: boolean;
  hasSharedArrayBuffer: boolean;
  /** Isolation needs a secure context; http:// on a LAN IP is not one, localhost is. */
  isSecureContext: boolean;
  origin: string;
  protocol: string;
  /** What the server actually sent, as opposed to what the config says it should send. */
  coop: string | null;
  coep: string | null;
  browser: string;
  /** Best guess at the single thing to fix, in order of likelihood. */
  verdict: string;
}

/**
 * Ask the page why isolation is off, instead of guessing from the other end of a chat.
 *
 * The headers are re-read straight off the network rather than trusted from the config:
 * the most common cause by far is a dev server that was started before the config gained
 * those headers, and in that case the config looks perfect while the responses have nothing.
 */
export async function diagnoseIsolation(): Promise<IsolationDiagnosis> {
  let coop: string | null = null;
  let coep: string | null = null;
  try {
    const res = await fetch(location.href, { method: 'GET', cache: 'no-store' });
    coop = res.headers.get('cross-origin-opener-policy');
    coep = res.headers.get('cross-origin-embedder-policy');
  } catch {
    /* leave them null — that itself is informative */
  }

  const crossOriginIsolated = self.crossOriginIsolated === true;
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  const isSecureContext = self.isSecureContext === true;
  const browser = detectBrowser();

  let verdict: string;
  if (crossOriginIsolated) {
    verdict = '정상 — isolation이 켜져 있습니다.';
  } else if (!coop && !coep) {
    verdict =
      '서버가 COOP/COEP 헤더를 아예 안 보내고 있습니다. dev 서버를 완전히 종료하고 ' +
      '"npm run dev"로 다시 켜세요. (설정 파일이 바뀌어도 이미 떠 있던 서버에는 안 붙습니다.)';
  } else if (!isSecureContext) {
    verdict =
      `${location.origin}은 보안 컨텍스트가 아닙니다. localhost 또는 127.0.0.1로 접속하세요. ` +
      'LAN IP에 http로 붙으면 isolation이 켜지지 않습니다.';
  } else if (coep === 'credentialless' && browser === 'Safari') {
    verdict =
      'Safari는 COEP credentialless를 지원하지 않습니다. vite.config.ts에서 require-corp로 ' +
      '바꾸고 모델을 public/models/에 직접 두세요.';
  } else if (coop !== 'same-origin') {
    verdict = `COOP 값이 "${coop}"입니다. "same-origin"이어야 합니다.`;
  } else {
    verdict =
      `헤더는 도착했는데(COOP=${coop}, COEP=${coep}) isolation이 안 켜졌습니다. ` +
      '확장 프로그램이 페이지에 개입하고 있을 수 있으니 시크릿 창에서 열어보세요.';
  }

  return {
    crossOriginIsolated,
    hasSharedArrayBuffer,
    isSecureContext,
    origin: location.origin,
    protocol: location.protocol,
    coop,
    coep,
    browser,
    verdict,
  };
}

function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  // Chrome's UA also says Safari, so Chrome has to be ruled out first.
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return '알 수 없음';
}

/* ---------------------------------------------------------------- decoding */

/**
 * Decode any browser-supported audio file to stereo Float32 at 44.1kHz.
 *
 * OfflineAudioContext does the resampling: constructing it at the target rate and rendering
 * the decoded buffer through it is the standard trick, and it is far better quality than a
 * hand-rolled linear interpolation.
 */
export async function decodeToModelRate(
  source: Blob,
): Promise<{ channels: StemChannels; durationMs: number }> {
  const bytes = await source.arrayBuffer();

  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes);
  } finally {
    void decodeCtx.close();
  }

  let buffer = decoded;
  if (decoded.sampleRate !== MODEL_SAMPLE_RATE) {
    const frames = Math.ceil(decoded.duration * MODEL_SAMPLE_RATE);
    const offline = new OfflineAudioContext(2, frames, MODEL_SAMPLE_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    buffer = await offline.startRendering();
  }

  const left = buffer.getChannelData(0);
  // Mono sources: feed the same channel to both sides rather than half a stereo image.
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

  return {
    channels: { left: new Float32Array(left), right: new Float32Array(right) },
    durationMs: (buffer.length / MODEL_SAMPLE_RATE) * 1000,
  };
}

export function packStems(
  bass: StemChannels,
  minusBass: StemChannels,
  durationMs: number,
  model: string,
): StemSet {
  return {
    bass: encodeWav(bass, MODEL_SAMPLE_RATE),
    minusBass: encodeWav(minusBass, MODEL_SAMPLE_RATE),
    sampleRate: MODEL_SAMPLE_RATE,
    durationMs,
    model,
    createdAt: Date.now(),
  };
}

/* -------------------------------------------------------- local import path */

export interface ImportResult {
  stems: StemSet;
  /** True when summing back overshot — usually a sign the files are not from the same run. */
  clipped: boolean;
}

/**
 * Build a StemSet from an externally produced bass stem.
 *
 * Feed it the original file plus the `bass.wav` that a local Demucs run produced. The
 * minus-one side is `original - bass`, so there is no need to also import drums/other/vocals.
 */
export async function importBassStem(
  original: Blob,
  bassStem: Blob,
  onProgress: ProgressFn,
): Promise<ImportResult> {
  onProgress({ phase: 'decoding', progress: 0, message: '원본 디코딩 중' });
  const originalAudio = await decodeToModelRate(original);

  onProgress({ phase: 'decoding', progress: 0.5, message: '베이스 스템 디코딩 중' });
  const bassAudio = await decodeToModelRate(bassStem);

  const lengthGapMs = Math.abs(originalAudio.durationMs - bassAudio.durationMs);
  if (lengthGapMs > 250) {
    throw new Error(
      `길이가 ${(lengthGapMs / 1000).toFixed(1)}초 어긋납니다. ` +
        '같은 원본에서 나온 스템이 맞는지 확인하세요.',
    );
  }

  onProgress({ phase: 'encoding', progress: 0, message: '반주 트랙 계산 중' });
  const minusBass = subtractStems(originalAudio.channels, bassAudio.channels);

  return {
    stems: packStems(bassAudio.channels, minusBass, originalAudio.durationMs, 'imported'),
    clipped: peakOf(minusBass) > 1.0001,
  };
}

/* ------------------------------------------------------------ lazy backend */

/**
 * Load the ONNX-backed separator on demand.
 *
 * If `npm install` was never re-run after these dependencies were added, this rejects with
 * something actionable instead of the app failing to boot at all.
 */
export async function loadDemucsSeparator(): Promise<Separator> {
  try {
    const mod = await import('./demucsBackend');
    return new mod.DemucsSeparator();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      '분리 엔진을 불러오지 못했습니다. 의존성이 빠졌을 수 있으니 프로젝트 폴더에서 ' +
        '"npm install"을 다시 실행하고 dev 서버를 재시작하세요. (원문: ' +
        detail +
        ')',
    );
  }
}
