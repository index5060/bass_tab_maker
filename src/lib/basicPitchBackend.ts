/**
 * basic-pitch, in the browser. Isolated in its own module on purpose.
 *
 * Same reasoning as demucsBackend.ts: Vite resolves a dynamic `import()` specifier while it
 * transforms the file that contains it, so only this module mentions `@spotify/basic-pitch`
 * (and through it TensorFlow.js), and it is reached only via `loadBasicPitch()` in autoTab.ts.
 * A missing package costs the AI transcriber — the built-in detector takes over — never the app.
 *
 * This is the same Spotify model the sidecar runs in Python, published by Spotify as a
 * TypeScript port. Running it here is what lets AI transcription work with nothing installed.
 *
 * Nothing else should import this file directly.
 */

import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import type { DetectedNote } from './transcribe';

/** The model is trained on, and only accepts, 22050Hz mono. */
export const BASIC_PITCH_SAMPLE_RATE = 22050;

/** Served by scripts/basicPitchModel.ts. Relative, because the app is built with base './'. */
const MODEL_PATH = 'models/basic-pitch/model.json';

// The Python package's `predict()` defaults, so both runtimes hear the same notes.
const ONSET_THRESHOLD = 0.5;
const FRAME_THRESHOLD = 0.3;
/** 127.7ms, in model frames (22050 / 256 per second) — Python's minimum_note_length. */
const MIN_NOTE_FRAMES = 11;
const ENERGY_TOLERANCE = 11;
// Pinned to the bass register, exactly as the sidecar asks for: anything outside it in a
// separated bass stem is bleed or a harmonic.
const MIN_FREQ_HZ = 30;
const MAX_FREQ_HZ = 500;

let model: BasicPitch | null = null;

/**
 * Notes from mono 22050Hz audio. `onProgress` receives 0..1 across the model run.
 *
 * Kept one-instance-per-page: the model graph is loaded and compiled once, so a second song
 * (or the tempo buttons re-running nothing) pays only for inference.
 */
export async function detectNotes(
  mono22050: Float32Array,
  onProgress?: (fraction: number) => void,
): Promise<DetectedNote[]> {
  model ??= new BasicPitch(new URL(MODEL_PATH, document.baseURI).href);

  const frames: number[][] = [];
  const onsets: number[][] = [];
  await model.evaluateModel(
    mono22050,
    (f, o) => {
      frames.push(...f);
      onsets.push(...o);
    },
    (p) => onProgress?.(p),
  );

  const events = noteFramesToTime(
    outputToNotesPoly(
      frames,
      onsets,
      ONSET_THRESHOLD,
      FRAME_THRESHOLD,
      MIN_NOTE_FRAMES,
      true,
      MAX_FREQ_HZ,
      MIN_FREQ_HZ,
      true,
      ENERGY_TOLERANCE,
    ),
  );

  return events
    .map((e) => ({
      midi: e.pitchMidi,
      startMs: Math.round(e.startTimeSeconds * 1000),
      endMs: Math.round((e.startTimeSeconds + e.durationSeconds) * 1000),
      confidence: Number(e.amplitude.toFixed(3)),
    }))
    .sort((a, b) => a.startMs - b.startMs);
}
