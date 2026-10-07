/**
 * Bass stem in, tab out.
 *
 * Ties together the pieces that are individually testable: decode -> mono -> decimate ->
 * YIN -> note segmentation -> quantise -> fretboard -> alphaTex. Everything here is
 * orchestration; the parts that can be wrong on their own live in pitch.ts and transcribe.ts
 * and are tested against synthetic material there.
 *
 * Only ever point this at the SEPARATED bass stem. Run on a full mix it produces nonsense,
 * because YIN assumes one note at a time.
 */

import { decodeToModelRate, MODEL_SAMPLE_RATE } from './separator';
import { decimate, toMono, trackPitch, midiToName } from './pitch';
import {
  segmentNotesDetailed,
  suggestRmsGate,
  medianSmoothFrames,
  mergeNearbyNotes,
  resolveOverlaps,
  dropOvertones,
  attackEnvelope,
  refineWithEnvelope,
  repairOctaveJumps,
  searchTempo,
  gridPhase,
  fitGrid,
  quantizeNotes,
  fillDurations,
  mapToFretboard,
  toAlphaTex,
  type SegmentStats,
  type DetectedNote,
  type Subdivision,
} from './transcribe';

/** 44100 / 4. Keeps everything a bass can produce and makes the search four times cheaper. */
const DECIMATION = 4;
const ANALYSIS_RATE = MODEL_SAMPLE_RATE / DECIMATION;

export type AutoTabPhase = 'decoding' | 'analysing' | 'transcribing' | 'done';

export interface AutoTabProgress {
  phase: AutoTabPhase;
  progress: number;
  message?: string;
}

export interface AutoTabOptions {
  /** Leave undefined to estimate from the note onsets. */
  bpm?: number;
  title: string;
  onProgress?: (p: AutoTabProgress) => void;
}

/** What the UI keeps after a run — enough to explain an empty result. */
export interface AutoTabSummary {
  notes: number;
  bpm: number;
  engine: TabEngine;
  confidence: number;
  /** Set when the AI engine could not run and the built-in detector stood in for it. */
  fallbackReason?: string;
  // Reuse the result's stats type so the two can never drift apart again — they did once.
  stats: AutoTabResult['stats'];
}

/** One detected note, in plain terms — what the diagnostic export is made of. */
export interface DiagnosticNote {
  name: string;
  midi: number;
  startMs: number;
  endMs: number;
  confidence: number;
}

/** Which ears produced the notes. The writing pipeline downstream is identical. */
export type TabEngine = 'yin' | 'basic-pitch';

export interface AutoTabResult {
  alphaTex: string;
  bpm: number;
  engine: TabEngine;
  noteCount: number;
  /**
   * Every note the detector kept, before quantisation. This exists because debugging a
   * transcription by squinting at the rendered tab is guesswork — the honest record of what
   * was heard, with times and confidences, is what actually settles "왜 안 맞지".
   */
  detectedNotes: DiagnosticNote[];
  /** Mean detector confidence — a rough "how much should I trust this" number. */
  meanConfidence: number;
  durationMs: number;
  /** Where the notes went, so an empty result can explain itself. */
  stats: SegmentStats & {
    peakBeforeNormalise: number;
    droppedOffFretboard: number;
    /** Mean distance from each onset to its grid line — how well the tempo fit the playing. */
    gridErrorMs: number;
    /** Phase of the fitted grid. Non-zero when the recording does not start on a barline. */
    offsetMs: number;
    /**
     * How firmly the onsets locked onto the chosen tempo, 0..1. Low means the tempo is a
     * guess dressed up as a number, and every bar line after it is suspect.
     */
    tempoStrength: number;
    /** Share of the recording that produced notes at all. */
    coverage: number;
    /** The longest stretch with no notes. A hole here becomes a wall of rests in the tab. */
    largestGapMs: number;
    /** Notes pulled back down an octave by the harmonic-slip repair. */
    octavesRepaired: number;
    /** 3 when the recording shuffles — the beat is cut in three, not four. */
    subdivision: Subdivision;
  };
}

/**
 * Scale the stem so the analysis sees a consistent level.
 *
 * A separated bass stem is only a slice of the original mix's energy, and how loud that
 * slice comes out varies wildly between songs. Normalising first means the gates downstream
 * are comparing against something predictable instead of against whatever the master
 * engineer and the separator happened to leave behind.
 */
function normalise(samples: Float32Array): { normalised: Float32Array; peak: number } {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  if (peak < 1e-9) return { normalised: samples, peak };

  const gain = 0.95 / peak;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return { normalised: out, peak };
}

export async function transcribeBassStem(
  bassStem: Blob,
  options: AutoTabOptions,
): Promise<AutoTabResult> {
  const report = options.onProgress ?? (() => {});

  report({ phase: 'decoding', progress: 0, message: '베이스 스템 디코딩 중' });
  const { channels, durationMs } = await decodeToModelRate(bassStem);

  report({ phase: 'analysing', progress: 0.2, message: '음정 추적 중' });
  const { normalised, peak } = normalise(toMono(channels.left, channels.right));
  const mono = decimate(normalised, DECIMATION);
  const frames = trackPitch(mono, {
    sampleRate: ANALYSIS_RATE,
    windowSize: 1024,
    hopSize: 128,
    minHz: 35,
    maxHz: 500,
  });

  report({ phase: 'transcribing', progress: 0.8, message: '음표로 정리하는 중' });
  // Median smoothing first: an isolated octave flip would otherwise split a note in half
  // and leave a wrong-octave fragment in the tab.
  const smoothed = medianSmoothFrames(frames);
  // Derive the level gate from this stem rather than trusting a constant — see suggestRmsGate.
  // Confidence is set below the library default on purpose: real playing (vibrato, fret
  // noise, decaying tails) scores lower than synthetic tones, and every missed real note
  // punches a hole in the line that the grid fit then mistakes for rhythm.
  const segmented = segmentNotesDetailed(smoothed, {
    rmsGate: suggestRmsGate(smoothed),
    minConfidence: 0.35,
  });
  const result = notesToAutoTab({
    notes: segmented.notes,
    durationMs,
    title: options.title,
    bpm: options.bpm,
    engine: 'yin',
    stats: segmented.stats,
    peakBeforeNormalise: peak,
  });

  report({ phase: 'done', progress: 1 });
  return result;
}

/* ------------------------------------------------ AI path, in the browser */

/**
 * Bass stem in, tab out, through basic-pitch running in the page — no install, no sidecar.
 *
 * Same model as the sidecar's, and the same writing pipeline after it (notesToAutoTab), so
 * the only thing that differs from the sidecar path is where the network runs. Throws when
 * the model cannot load; the caller falls back to the built-in detector.
 */
export async function transcribeBassStemAI(
  bassStem: Blob,
  options: AutoTabOptions,
): Promise<AutoTabResult> {
  const report = options.onProgress ?? (() => {});

  report({ phase: 'decoding', progress: 0, message: '베이스 스템 디코딩 중' });
  const { channels, durationMs } = await decodeToModelRate(bassStem);
  // Normalised for the same reason as the YIN path: the model's thresholds are absolute, and
  // a separated stem's level depends on the song, not the playing.
  const { normalised, peak } = normalise(toMono(channels.left, channels.right));
  // 44100 / 2 = 22050, the model's rate. A two-tap average is ample anti-aliasing here: the
  // stem is bass, and the model is told to ignore everything above 500Hz anyway.
  const mono = decimate(normalised, MODEL_SAMPLE_RATE / 22050);

  report({ phase: 'analysing', progress: 0.1, message: 'AI 모델 불러오는 중' });
  const backend = await loadBasicPitch();
  const heard = await backend.detectNotes(mono, (fraction) =>
    report({
      phase: 'analysing',
      progress: 0.1 + fraction * 0.75,
      message: `AI 채보 중 ${Math.round(fraction * 100)}%`,
    }),
  );
  // The model is sure of pitch and loose about time; the waveform is the reverse. Overtones
  // come out first so the halves of a note they split can be joined back together.
  const notes = refineWithEnvelope(dropOvertones(heard), attackEnvelope(mono, 22050));

  report({ phase: 'transcribing', progress: 0.9, message: '탭으로 정리하는 중' });
  const result = notesToAutoTab({
    notes,
    durationMs,
    title: options.title,
    bpm: options.bpm,
    engine: 'basic-pitch',
    peakBeforeNormalise: peak,
  });
  report({ phase: 'done', progress: 1 });
  return result;
}

/**
 * Load the TensorFlow.js-backed transcriber on demand (see basicPitchBackend.ts for why it is
 * kept out of the static import graph).
 */
async function loadBasicPitch(): Promise<typeof import('./basicPitchBackend')> {
  try {
    return await import('./basicPitchBackend');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `AI 채보 엔진을 불러오지 못했습니다. 프로젝트 폴더에서 "npm install"을 다시 실행하세요. (원문: ${detail})`,
    );
  }
}

/* --------------------------------------------------------- notes -> tab */

export interface NotesToTabInput {
  notes: DetectedNote[];
  durationMs: number;
  title: string;
  /** User-typed tempo pins the grid; undefined estimates it from the onsets. */
  bpm?: number;
  engine: TabEngine;
  /** Detector statistics when the notes came from the local pipeline. */
  stats?: SegmentStats;
  peakBeforeNormalise?: number;
}

/**
 * Everything after "we have notes": clean, fit the grid, quantise, place on the fretboard,
 * write alphaTex.
 *
 * Split out so the AI transcription path (basic-pitch on the sidecar) and the built-in YIN
 * path share every line of the writing pipeline — only the ears differ. Whatever accuracy
 * problems remain downstream get fixed once, for both.
 */
export function notesToAutoTab(input: NotesToTabInput): AutoTabResult {
  // Keep the instrument's range honest for notes that arrived from outside the local
  // detector — the segmenter already filtered its own.
  // 28..67 is E1..G4 — the range of a standard-tuned (E A D G) 4-string bass.
  const inRange = input.notes.filter((n) => n.midi >= 28 && n.midi <= 67);
  // basic-pitch hears chords; a bass line is one note at a time. Overtones go first, judged
  // against everything under them, then whatever still overlaps is settled pairwise.
  const monophonic = resolveOverlaps(dropOvertones(inRange));

  // Merge only for the YIN path. There it heals level-gate dropouts inside one held note;
  // basic-pitch detects onsets explicitly, so a same-pitch note after a short gap is a real
  // repeated note — and repeated same-pitch eighths are the single most common bass figure.
  // Merging those glued a pumping eighth-note line into one long note.
  const merged = (input.engine === 'yin' ? mergeNearbyNotes(monophonic) : monophonic).sort(
    (a, b) => a.startMs - b.startMs,
  );

  // Undo harmonic slips before anything downstream reads the pitches.
  const notes = repairOctaveJumps(merged);
  const octavesRepaired = notes.reduce(
    (count, note, i) => count + (note.midi === merged[i].midi ? 0 : 1),
    0,
  );

  // Search the whole plausible tempo range against every onset, rather than seeding from a
  // summary of the gaps. The seeded version returned 112.4 BPM on a 146 BPM song and then
  // faithfully refined that, putting every bar line in the wrong place.
  const userBpm = input.bpm && input.bpm > 0 ? input.bpm : undefined;
  const searched = userBpm
    ? { bpm: userBpm, subdivision: 4 as Subdivision, ...gridPhase(notes, userBpm) }
    : searchTempo(notes);

  // Least-squares refinement gets a vote, not a veto — and it has to earn it on the same
  // measurement. It refines from its seed rather than searching, so across the silent
  // stretches in a real recording its slot assignments accumulate error and it wanders: on
  // the song that motivated all this it moved 146.00 to 146.12, which sounds like nothing
  // and is two sixteenths of drift by the end of four minutes. Measured error doubled.
  // Keeping whichever grid the onsets actually sit closer to needs no threshold to tune.
  // Only for straight time. fitGrid measures against a sixteenth grid, so on a shuffle it
  // would be scoring the wrong ruler and its verdict would mean nothing.
  const refined =
    userBpm || searched.subdivision !== 4 ? null : fitGrid(notes, searched.bpm);
  const useRefined = refined !== null && refined.meanAbsErrorMs < searched.meanAbsErrorMs;
  const bpm = useRefined ? refined.bpm : searched.bpm;
  const offsetMs = useRefined ? refined.offsetMs : searched.offsetMs;
  const gridErrorMs = useRefined ? refined.meanAbsErrorMs : searched.meanAbsErrorMs;

  const quantized = fillDurations(
    quantizeNotes(notes, bpm, offsetMs, searched.subdivision),
  );
  const fretted = mapToFretboard(quantized);
  const coverage = coverageOf(notes, input.durationMs);

  // Pad the score out to cover the whole recording, so playback does not stop early on a
  // quiet ending and the sync anchors have somewhere to live.
  const beatsPerBar = 4;
  const barsForAudio = Math.ceil((input.durationMs / 1000 / (60 / bpm)) / beatsPerBar);

  const alphaTex = toAlphaTex(fretted, {
    title: input.title,
    bpm,
    minBars: Math.max(1, barsForAudio),
    // Written as straight eighths with the feel called out, the way a shuffle is always
    // notated — the triplet lives in the marking, not in a bracket over every beat.
    feel: searched.subdivision === 3 ? 'shuffle' : undefined,
  });

  const stats: SegmentStats = input.stats ?? {
    frames: 0,
    voicedFrames: 0,
    rawNotes: input.notes.length,
    droppedTooShort: 0,
    droppedOutOfRange: input.notes.length - inRange.length,
    kept: notes.length,
    medianRms: 0,
    medianConfidence: medianOf(notes.map((n) => n.confidence)),
    rmsGateUsed: 0,
  };

  return {
    alphaTex,
    bpm,
    engine: input.engine,
    noteCount: fretted.length,
    detectedNotes: notes.slice(0, 2000).map((n) => ({
      name: midiToName(n.midi),
      midi: n.midi,
      startMs: Math.round(n.startMs),
      endMs: Math.round(n.endMs),
      confidence: Number(n.confidence.toFixed(3)),
    })),
    meanConfidence: notes.length
      ? notes.reduce((sum, n) => sum + n.confidence, 0) / notes.length
      : 0,
    durationMs: input.durationMs,
    stats: {
      ...stats,
      peakBeforeNormalise: input.peakBeforeNormalise ?? 1,
      droppedOffFretboard: quantized.length - fretted.length,
      gridErrorMs,
      offsetMs,
      tempoStrength: searched.strength,
      coverage: coverage.ratio,
      largestGapMs: coverage.largestGapMs,
      octavesRepaired,
      subdivision: searched.subdivision,
    },
  };
}

/**
 * How much of the recording actually produced notes, and where the biggest hole is.
 *
 * Without this a passage the detector lost — a quiet verse, a section where separation gave
 * up — turns into bars of rests that look exactly like bars the bassist rested through. The
 * tab says nothing was played; the recording says otherwise. Measuring it lets the UI say
 * "13 seconds produced nothing" instead of letting the silence pass for transcription.
 */
function coverageOf(
  notes: DetectedNote[],
  durationMs: number,
): { ratio: number; largestGapMs: number } {
  if (notes.length === 0 || durationMs <= 0) return { ratio: 0, largestGapMs: durationMs };

  let sounding = 0;
  // Interior gaps only. An intro before the bass enters and an outro after it stops are the
  // song, not a detection failure, and letting them win this measurement would raise an alarm
  // on every normal recording — which trains you to ignore the alarm.
  let largestGapMs = 0;
  let previousEnd = notes[0].startMs;

  for (const note of notes) {
    const gap = note.startMs - previousEnd;
    if (gap > largestGapMs) largestGapMs = gap;
    sounding += Math.max(0, note.endMs - Math.max(note.startMs, previousEnd));
    previousEnd = Math.max(previousEnd, note.endMs);
  }

  // Measure against the stretch the bass actually spans, for the same reason.
  const span = Math.max(1, previousEnd - notes[0].startMs);
  return { ratio: Math.min(1, sounding / span), largestGapMs };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}
