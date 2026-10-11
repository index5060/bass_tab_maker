/**
 * The tab analysis, off the main thread: seconds of number crunching per song, during which
 * the page would otherwise freeze.
 */

import { analyseTab, type AnalysisStage } from './index';
import { decodeStem, type MonoAudio } from './decode';

export type WorkerAudio = Blob | MonoAudio;

export interface AnalyseRequest {
  id: number;
  bass: WorkerAudio;
  band: WorkerAudio | null;
  bpm?: number;
}

export type AnalyseReply =
  | { id: number; type: 'stage'; stage: 'decoding' | AnalysisStage }
  | { id: number; type: 'done'; analysis: ReturnType<typeof analyseTab> }
  | { id: number; type: 'error'; message: string; undecodable?: boolean };

interface WorkerScope {
  onmessage: ((event: MessageEvent<AnalyseRequest>) => void) | null;
  postMessage(message: AnalyseReply): void;
}
const scope = self as unknown as WorkerScope;

const asAudio = async (audio: WorkerAudio): Promise<MonoAudio> => (audio instanceof Blob ? decodeStem(audio) : audio);

scope.onmessage = async (event) => {
  const { id, bpm } = event.data;
  let decoded: { bass: MonoAudio; band: MonoAudio | null };
  try {
    scope.postMessage({ id, type: 'stage', stage: 'decoding' });
    decoded = {
      bass: await asAudio(event.data.bass),
      band: event.data.band ? await asAudio(event.data.band) : null,
    };
  } catch (e) {
    scope.postMessage({ id, type: 'error', message: e instanceof Error ? e.message : String(e), undecodable: true });
    return;
  }
  try {
    const { bass, band } = decoded;
    // Both stems come out of the same separation, so they share a rate; if they somehow do
    // not, the band is only a beat source and is better dropped than misread.
    const analysis = analyseTab(
      {
        bass: bass.samples,
        band: band && band.sampleRate === bass.sampleRate ? band.samples : null,
        sampleRate: bass.sampleRate,
        bpm,
      },
      (stage) => scope.postMessage({ id, type: 'stage', stage }),
    );
    scope.postMessage({ id, type: 'done', analysis });
  } catch (e) {
    scope.postMessage({ id, type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
