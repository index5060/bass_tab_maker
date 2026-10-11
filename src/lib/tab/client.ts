/**
 * Run the tab analysis on a song's stems, in a worker, with progress.
 *
 * The bass stem is what is transcribed; the minus-bass stem is where the beat comes from (the
 * drums are in it). Both are decoded inside the worker. A stem wav.ts cannot read is decoded
 * here with Web Audio instead and handed over as samples, and a browser that cannot start the
 * worker gets the analysis on the main thread — slower to use, same result.
 */

import type { StemSet } from '../stems';
import { decodeToModelRate, MODEL_SAMPLE_RATE } from '../separator';
import { analyseTab, type AnalysisStage, type TabAnalysis } from './index';
import { decodeStem, toMonoSamples, type MonoAudio } from './decode';
import type { AnalyseReply, AnalyseRequest, WorkerAudio } from './worker';

export type TabStage = 'decoding' | AnalysisStage;

export interface TabProgress {
  stage: TabStage;
  /** 0..1, roughly proportional to the time each stage takes. */
  progress: number;
  message: string;
}

const STAGES: Record<TabStage, [number, string]> = {
  decoding: [0.05, '스템 읽는 중'],
  beats: [0.15, '반주에서 박자 찾는 중'],
  notes: [0.4, '베이스 음 읽는 중'],
  bars: [0.9, '마디·줄·프렛 정하는 중'],
};

export function stageProgress(stage: TabStage): TabProgress {
  const [progress, message] = STAGES[stage];
  return { stage, progress, message };
}

class Undecodable extends Error {}
class WorkerUnavailable extends Error {}

let nextId = 1;

function inWorker(
  bass: WorkerAudio,
  band: WorkerAudio | null,
  bpm: number | undefined,
  onProgress: (p: TabProgress) => void,
): Promise<TabAnalysis> {
  if (typeof Worker === 'undefined') return Promise.reject(new WorkerUnavailable());
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(new WorkerUnavailable());
      return;
    }
    const id = nextId++;
    let heard = false;
    worker.onmessage = (event: MessageEvent<AnalyseReply>) => {
      const reply = event.data;
      if (reply.id !== id) return;
      heard = true;
      if (reply.type === 'stage') {
        onProgress(stageProgress(reply.stage));
        return;
      }
      worker.terminate();
      if (reply.type === 'done') resolve(reply.analysis);
      else reject(reply.undecodable ? new Undecodable(reply.message) : new Error(reply.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      // An error before the first reply means the worker never ran (blocked, failed to load).
      reject(heard ? new Error(event.message || '탭 분석 중 오류가 났습니다.') : new WorkerUnavailable());
    };
    const request: AnalyseRequest = { id, bass, band, bpm };
    worker.postMessage(request);
  });
}

/** Web Audio decoding, for whatever wav.ts cannot read. Main thread only. */
async function decodeHere(blob: Blob): Promise<MonoAudio> {
  const { channels } = await decodeToModelRate(blob);
  return { samples: toMonoSamples([channels.left, channels.right]), sampleRate: MODEL_SAMPLE_RATE };
}

export async function analyseStems(
  stems: Pick<StemSet, 'bass' | 'minusBass'>,
  options: { bpm?: number; onProgress?: (p: TabProgress) => void } = {},
): Promise<TabAnalysis> {
  const report = options.onProgress ?? (() => {});
  report(stageProgress('decoding'));
  try {
    return await inWorker(stems.bass, stems.minusBass, options.bpm, report);
  } catch (e) {
    if (e instanceof Undecodable) {
      const bass = await decodeHere(stems.bass);
      const band = await decodeHere(stems.minusBass);
      return inWorker(bass, band, options.bpm, report).catch((again) => {
        if (again instanceof WorkerUnavailable) return here(bass, band, options.bpm, report);
        throw again;
      });
    }
    if (e instanceof WorkerUnavailable) {
      const bass = await decodeStem(stems.bass).catch(() => decodeHere(stems.bass));
      const band = await decodeStem(stems.minusBass).catch(() => decodeHere(stems.minusBass));
      return here(bass, band, options.bpm, report);
    }
    throw e;
  }
}

function here(bass: MonoAudio, band: MonoAudio, bpm: number | undefined, report: (p: TabProgress) => void): TabAnalysis {
  return analyseTab(
    { bass: bass.samples, band: band.sampleRate === bass.sampleRate ? band.samples : null, sampleRate: bass.sampleRate, bpm },
    (stage) => report(stageProgress(stage)),
  );
}

/** What the panel shows about the tab on screen. */
export interface TabSummary {
  /** The song it was made for: a result must not be shown against another song. */
  songId: string;
  notes: number;
  /** Tempo written at the top of the tab. */
  bpm: number;
  beatsPerBar: number;
  downbeatPhase: number;
  /** 0..1: how clearly the analysis found "one". */
  downbeatConfidence: number;
  tuningCents: number;
  bars: number;
  beatSource: 'band' | 'bass';
  /** Set when the tempo was given rather than found. */
  pinnedBpm?: number;
}

export function summariseTab(
  songId: string,
  analysis: TabAnalysis,
  tab: { notes: unknown[]; bpm: number; beatsPerBar: number; downbeatPhase: number; bars: number },
  pinnedBpm?: number,
): TabSummary {
  return {
    songId,
    notes: tab.notes.length,
    bpm: tab.bpm,
    beatsPerBar: tab.beatsPerBar,
    downbeatPhase: tab.downbeatPhase,
    downbeatConfidence: analysis.meter.confidence,
    tuningCents: analysis.tuningCents,
    bars: tab.bars,
    beatSource: analysis.beatSource,
    pinnedBpm,
  };
}
