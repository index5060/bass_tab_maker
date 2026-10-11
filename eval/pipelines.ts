/**
 * The transcription pipeline under test, run in Node on raw samples.
 *
 * (The pipeline it replaced — YIN note segmentation with a fitted grid — scored 12% on this
 * set, 0% on most conditions; see the commit that introduced src/lib/tab.)
 */
import { transcribeTab } from '../src/lib/tab';

export interface PipelineInput {
  /** Bass stem, mono, 44.1kHz. */
  bass: Float32Array;
  /** Everything but the bass, mono, 44.1kHz. */
  rest: Float32Array;
  sampleRate: number;
  title: string;
}

/** Beats from the band, notes on the beat grid, metre, frets, writer. */
export function tabPipeline(input: PipelineInput): string {
  return transcribeTab({ bass: input.bass, band: input.rest, sampleRate: input.sampleRate, title: input.title }).alphaTex;
}
