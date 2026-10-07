/**
 * The ONNX-backed separator. Isolated in its own module on purpose.
 *
 * Vite resolves the specifier of a dynamic `import()` while transforming the file that
 * contains it, so any module mentioning `onnxruntime-web` fails to transform when that
 * package is absent. Keeping those mentions here — and reaching this module only through
 * `loadDemucsSeparator()` in separator.ts — means a missing or half-finished `npm install`
 * costs you the separate button, not the whole app.
 *
 * Nothing else should import this file directly.
 */

import { buildMinusBass, type DemucsResult, type StemSet } from './stems';
import { decodeToModelRate, packStems, type ProgressFn, type Separator } from './separator';
import { fetchModelCached } from './modelCache';

export interface DemucsSeparatorOptions {
  /**
   * Where the ONNX model lives. Same-origin (`/models/htdemucs_embedded.onnx`) is strongly
   * preferred: with cross-origin isolation on, a remote model needs the right CORP/CORS
   * headers, and a 172MB download you cannot cache locally gets old fast.
   */
  modelUrl?: string;
}

export class DemucsSeparator implements Separator {
  private _processor: unknown = null;
  private _modelLoaded = false;
  private _options: DemucsSeparatorOptions;

  constructor(options: DemucsSeparatorOptions = {}) {
    this._options = options;
  }

  async separate(source: Blob, onProgress: ProgressFn): Promise<StemSet> {
    onProgress({ phase: 'decoding', progress: 0, message: '오디오 디코딩 중' });
    const { channels, durationMs } = await decodeToModelRate(source);

    const [ort, demucs] = await Promise.all([import('onnxruntime-web'), import('demucs-web')]);

    // No cross-origin isolation means no SharedArrayBuffer, which means no WASM worker
    // threads. ORT would work this out itself and print a scary warning; saying it up front
    // is quieter and makes the intent obvious. WebGPU is unaffected either way — it never
    // uses SAB — so on a WebGPU machine this line costs nothing.
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      ort.env.wasm.numThreads = 1;
    }

    if (!this._processor) {
      this._processor = new demucs.DemucsProcessor({
        ort,
        onProgress: (info) => {
          onProgress({
            phase: 'separating',
            progress: info.progress,
            message: `구간 ${info.currentSegment}/${info.totalSegments}`,
          });
        },
        onDownloadProgress: (loaded, total) => {
          onProgress({
            phase: 'loading-model',
            progress: total > 0 ? loaded / total : 0,
            message: `모델 내려받는 중 ${fmtMb(loaded)} / ${fmtMb(total)}`,
          });
        },
      });
    }

    if (!this._modelLoaded) {
      onProgress({ phase: 'loading-model', progress: 0, message: '모델 준비 중' });
      const url = this._options.modelUrl ?? demucs.CONSTANTS.DEFAULT_MODEL_URL;
      let bytes: ArrayBuffer;
      try {
        // Fetched here rather than by demucs-web, so it is kept in the browser after the first
        // time instead of being downloaded again on every visit (see modelCache.ts).
        const model = await fetchModelCached(url, (loaded, total) =>
          onProgress({
            phase: 'loading-model',
            progress: total > 0 ? loaded / total : 0,
            message: `모델 내려받는 중 ${fmtMb(loaded)} / ${fmtMb(total)} (처음 한 번만)`,
          }),
        );
        bytes = model.bytes;
        if (model.fromCache) onProgress({ phase: 'loading-model', progress: 1, message: '저장된 모델 사용' });
      } catch (e) {
        // On its own this surfaces as "Failed to fetch", which says nothing about what was
        // being fetched or what to do about it.
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(
          `분리 모델(약 172MB)을 내려받지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요. ` +
            `한 번 받으면 브라우저에 저장돼 다음부터는 받지 않습니다. (원문: ${detail})`,
        );
      }
      await (this._processor as { loadModel(b: ArrayBuffer): Promise<void> }).loadModel(bytes);
      this._modelLoaded = true;
    }

    onProgress({ phase: 'separating', progress: 0, message: '분리 시작' });
    const result = (await (
      this._processor as { separate(l: Float32Array, r: Float32Array): Promise<DemucsResult> }
    ).separate(channels.left, channels.right)) as DemucsResult;

    onProgress({ phase: 'encoding', progress: 0, message: '스템 저장 중' });
    const stems = packStems(result.bass, buildMinusBass(result), durationMs, 'htdemucs (browser)');

    onProgress({ phase: 'done', progress: 1 });
    return stems;
  }
}

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}
