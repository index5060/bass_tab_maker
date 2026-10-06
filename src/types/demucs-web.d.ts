/**
 * Type declarations for `demucs-web`, which ships as plain JS with no bundled types.
 *
 * Written against the package's documented API rather than declared as `any`, so that a
 * future version changing the shape of `separate()` shows up as a compile error instead of
 * a runtime surprise halfway through a five-minute separation.
 */
declare module 'demucs-web' {
  export interface DemucsProgressInfo {
    /** 0..1 overall. */
    progress: number;
    currentSegment: number;
    totalSegments: number;
  }

  export interface DemucsStem {
    left: Float32Array;
    right: Float32Array;
  }

  export interface DemucsSeparationResult {
    drums: DemucsStem;
    bass: DemucsStem;
    other: DemucsStem;
    vocals: DemucsStem;
  }

  export interface DemucsProcessorOptions {
    /** The onnxruntime-web module namespace. */
    ort: unknown;
    modelPath?: string;
    sessionOptions?: unknown;
    onProgress?: (info: DemucsProgressInfo) => void;
    onLog?: (phase: string, message: string) => void;
    onDownloadProgress?: (loaded: number, total: number) => void;
  }

  export class DemucsProcessor {
    constructor(options: DemucsProcessorOptions);
    /** Accepts a URL or the model bytes directly. Defaults to CONSTANTS.DEFAULT_MODEL_URL. */
    loadModel(pathOrBuffer?: string | ArrayBuffer): Promise<void>;
    /** Input must be 44100Hz stereo. */
    separate(left: Float32Array, right: Float32Array): Promise<DemucsSeparationResult>;
  }

  export const CONSTANTS: {
    DEFAULT_MODEL_URL: string;
    [key: string]: unknown;
  };
}
