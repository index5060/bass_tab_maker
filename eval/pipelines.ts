/**
 * The transcription pipelines under test, run in Node on raw samples.
 */
import { decimate, trackPitch } from '../src/lib/pitch';
import { medianSmoothFrames, segmentNotesDetailed, suggestRmsGate } from '../src/lib/transcribe';
import { notesToAutoTab } from '../src/lib/autoTab';
import { transcribeTab } from '../src/lib/tab';

export interface PipelineInput {
  /** Bass stem, mono, 44.1kHz. */
  bass: Float32Array;
  /** Everything but the bass, mono, 44.1kHz. */
  rest: Float32Array;
  sampleRate: number;
  title: string;
}

/** The pipeline the app shipped before this rewrite: YIN on the stem, notesToAutoTab after. */
export function oldPipeline(input: PipelineInput): string {
  let peak = 0;
  for (const v of input.bass) peak = Math.max(peak, Math.abs(v));
  const normalised = input.bass.map((v) => (v * 0.95) / Math.max(peak, 1e-9));
  const mono = decimate(normalised, 4);
  const frames = trackPitch(mono, { sampleRate: input.sampleRate / 4, windowSize: 1024, hopSize: 128, minHz: 35, maxHz: 500 });
  const smoothed = medianSmoothFrames(frames);
  const segmented = segmentNotesDetailed(smoothed, { rmsGate: suggestRmsGate(smoothed), minConfidence: 0.35 });
  return notesToAutoTab({
    notes: segmented.notes,
    durationMs: (input.bass.length / input.sampleRate) * 1000,
    title: input.title,
    engine: 'yin',
    stats: segmented.stats,
    peakBeforeNormalise: peak,
  }).alphaTex;
}

/** The rewrite: beats from the band, notes on the beat grid, metre, frets, writer. */
export function newPipeline(input: PipelineInput): string {
  return transcribeTab({ bass: input.bass, band: input.rest, sampleRate: input.sampleRate, title: input.title }).alphaTex;
}
