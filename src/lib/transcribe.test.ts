import { describe, it, expect } from 'vitest';
import {
  segmentNotes,
  segmentNotesDetailed,
  medianSmoothFrames,
  mergeNearbyNotes,
  resolveOverlaps,
  dropOvertones,
  attackEnvelope,
  refineWithEnvelope,
  fitGrid,
  searchTempo,
  findRepeatPeriodMs,
  fillDurations,
  gridPhase,
  repairOctaveJumps,
  suggestRmsGate,
  quantizeNotes,
  mapToFretboard,
  toAlphaTex,
  estimateBpm,
  BASS_TUNING,
  type DetectedNote,
} from './transcribe';
import { trackPitch, midiToHz, type PitchFrame } from './pitch';
import { notesToAutoTab } from './autoTab';

const SR = 11025;

function frame(timeMs: number, hz: number, confidence = 0.9, rms = 0.2): PitchFrame {
  return { timeMs, hz, confidence, rms };
}

/** Frames covering a steady note, one every 12ms. */
function held(midi: number, fromMs: number, toMs: number, confidence = 0.9): PitchFrame[] {
  const out: PitchFrame[] = [];
  for (let t = fromMs; t < toMs; t += 12) out.push(frame(t, midiToHz(midi), confidence));
  return out;
}

function silence(fromMs: number, toMs: number): PitchFrame[] {
  const out: PitchFrame[] = [];
  for (let t = fromMs; t < toMs; t += 12) out.push(frame(t, 0, 0, 0));
  return out;
}

describe('segmentNotes', () => {
  it('groups steady frames into one note', () => {
    const notes = segmentNotes(held(33, 0, 500));
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(33);
    expect(notes[0].endMs - notes[0].startMs).toBeGreaterThan(400);
  });

  it('splits on a pitch change', () => {
    const notes = segmentNotes([...held(33, 0, 400), ...held(40, 400, 800)]);
    expect(notes.map((n) => n.midi)).toEqual([33, 40]);
  });

  it('splits on a gap of silence', () => {
    const notes = segmentNotes([...held(33, 0, 300), ...silence(300, 500), ...held(33, 500, 800)]);
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.midi === 33)).toBe(true);
  });

  it('drops notes shorter than the minimum', () => {
    // A 24ms blip between two real notes is detector chatter, not a note.
    const frames = [...held(33, 0, 300), ...held(45, 300, 324), ...held(33, 324, 600)];
    const notes = segmentNotes(frames, { minNoteMs: 60 });
    expect(notes.every((n) => n.midi === 33)).toBe(true);
  });

  it('ignores low-confidence frames', () => {
    const notes = segmentNotes(held(33, 0, 400, 0.2));
    expect(notes).toHaveLength(0);
  });

  it('ignores frames below the level gate', () => {
    const quiet = held(33, 0, 400).map((f) => ({ ...f, rms: 0.0001 }));
    expect(segmentNotes(quiet)).toHaveLength(0);
  });

  it('rejects pitches below the low E string', () => {
    // An octave error would land here; a 4-string bass cannot play it.
    expect(segmentNotes(held(16, 0, 400))).toHaveLength(0);
  });

  it('tolerates small wobble within one note', () => {
    const wobbly = held(33, 0, 400).map((f, i) => ({
      ...f,
      hz: midiToHz(33 + (i % 2 ? 0.3 : -0.3)),
    }));
    expect(segmentNotes(wobbly)).toHaveLength(1);
  });

  it('works end to end on a synthesised two-note line', () => {
    const makeTone = (hz: number, seconds: number) => {
      const n = Math.floor(SR * seconds);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        out[i] = 0.5 * (Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(4 * Math.PI * hz * t));
      }
      return out;
    };
    const a1 = makeTone(midiToHz(33), 0.6);
    const e2 = makeTone(midiToHz(40), 0.6);
    const signal = new Float32Array(a1.length + e2.length);
    signal.set(a1, 0);
    signal.set(e2, a1.length);

    const notes = segmentNotes(trackPitch(signal, { sampleRate: SR }));
    const pitches = notes.filter((n) => n.endMs - n.startMs > 200).map((n) => n.midi);
    expect(pitches).toEqual([33, 40]);
  });
});

describe('adaptive level gating', () => {
  // The bug this covers: a fixed rmsGate of 0.005 silenced a real separated stem entirely
  // and produced a page of rests. A separated bass carries only a slice of the mix's energy,
  // so how loud it lands varies enormously between songs.
  const quietLine = (level: number): PitchFrame[] => [
    ...held(33, 0, 400).map((f) => ({ ...f, rms: level })),
    ...silence(400, 500),
    ...held(40, 500, 900).map((f) => ({ ...f, rms: level })),
  ];

  it('would have been silenced by the old fixed gate', () => {
    // Proves the scenario is real rather than hypothetical.
    expect(segmentNotes(quietLine(0.002), { rmsGate: 0.005 })).toHaveLength(0);
  });

  it('finds the same notes at any level once the gate adapts', () => {
    for (const level of [0.5, 0.05, 0.002, 0.0004]) {
      const frames = quietLine(level);
      const notes = segmentNotes(frames, { rmsGate: suggestRmsGate(frames) });
      expect(notes.map((n) => n.midi), `level ${level}`).toEqual([33, 40]);
    }
  });

  it('still keeps the gate above the noise floor', () => {
    // Loud notes over a quiet noise bed: the bed must not become notes.
    const frames = [
      ...held(33, 0, 300).map((f) => ({ ...f, rms: 0.4 })),
      ...held(45, 300, 700).map((f) => ({ ...f, rms: 0.004, confidence: 0.55 })),
    ];
    const notes = segmentNotes(frames, { rmsGate: suggestRmsGate(frames) });
    expect(notes.map((n) => n.midi)).toEqual([33]);
  });

  it('returns a zero gate for a completely silent stem', () => {
    expect(suggestRmsGate(silence(0, 500))).toBe(0);
  });
});

describe('segmentNotesDetailed', () => {
  it('accounts for every note it threw away', () => {
    const frames = [
      ...held(33, 0, 400), // kept
      ...silence(400, 450),
      ...held(45, 450, 474), // too short
      ...silence(474, 520),
      ...held(16, 520, 900), // below the low E string
    ];
    const { notes, stats } = segmentNotesDetailed(frames);
    expect(notes).toHaveLength(1);
    expect(stats.kept).toBe(1);
    expect(stats.droppedTooShort).toBe(1);
    expect(stats.droppedOutOfRange).toBe(1);
    expect(stats.rawNotes).toBe(3);
    expect(stats.voicedFrames).toBeGreaterThan(0);
  });

  it('reports zero voiced frames for silence, which is what an empty result needs to say', () => {
    const { notes, stats } = segmentNotesDetailed(silence(0, 500));
    expect(notes).toHaveLength(0);
    expect(stats.voicedFrames).toBe(0);
    expect(stats.frames).toBeGreaterThan(0);
  });
});

describe('medianSmoothFrames', () => {
  it('erases an isolated octave flip inside a steady note', () => {
    // The failure this exists for: one frame jumps to the 2nd harmonic, splitting the note
    // and leaving a wrong-octave fragment in the tab.
    const frames = held(33, 0, 400);
    frames[10] = { ...frames[10], hz: midiToHz(45) }; // octave + fourth, one frame
    const smoothed = medianSmoothFrames(frames);
    const notes = segmentNotes(smoothed);
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(33);
  });

  it('leaves a genuine note change untouched', () => {
    const frames = [...held(33, 0, 400), ...held(40, 400, 800)];
    const notes = segmentNotes(medianSmoothFrames(frames));
    expect(notes.map((n) => n.midi)).toEqual([33, 40]);
  });

  it('does not invent pitch in unvoiced frames', () => {
    const frames = [...held(33, 0, 200), ...silence(200, 400)];
    const smoothed = medianSmoothFrames(frames);
    expect(smoothed.filter((f) => f.hz === 0).length).toBe(
      frames.filter((f) => f.hz === 0).length,
    );
  });
});

describe('mergeNearbyNotes', () => {
  const note = (midi: number, startMs: number, endMs: number): DetectedNote => ({
    midi,
    startMs,
    endMs,
    confidence: 0.9,
  });

  it('re-joins the same pitch across a sub-100ms dropout', () => {
    const merged = mergeNearbyNotes([note(33, 0, 300), note(33, 350, 700)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].endMs).toBe(700);
  });

  it('keeps genuinely repeated notes apart', () => {
    // A fresh attack after a real gap is a new note, not a dropout.
    const merged = mergeNearbyNotes([note(33, 0, 300), note(33, 500, 800)]);
    expect(merged).toHaveLength(2);
  });

  it('never merges across a pitch change', () => {
    const merged = mergeNearbyNotes([note(33, 0, 300), note(35, 320, 600)]);
    expect(merged).toHaveLength(2);
  });
});

describe('resolveOverlaps', () => {
  const note = (midi: number, startMs: number, endMs: number, confidence = 0.8): DetectedNote => ({
    midi,
    startMs,
    endMs,
    confidence,
  });

  it('keeps the fundamental when its octave is heard on the same attack', () => {
    const out = resolveOverlaps([note(33, 0, 450, 0.8), note(45, 5, 300, 0.9)]);
    expect(out).toEqual([note(33, 0, 450, 0.8)]);
  });

  it('treats an octave-and-fifth or two octaves the same way', () => {
    expect(resolveOverlaps([note(33, 0, 450), note(52, 10, 300)]).map((n) => n.midi)).toEqual([33]);
    expect(resolveOverlaps([note(33, 0, 450), note(57, 10, 300)]).map((n) => n.midi)).toEqual([33]);
  });

  it('keeps the more confident reading when two unrelated pitches share an attack', () => {
    // A semitone apart is a detector disagreeing with itself, not an overtone.
    const out = resolveOverlaps([note(33, 0, 450, 0.4), note(34, 10, 450, 0.9)]);
    expect(out.map((n) => n.midi)).toEqual([34]);
    expect(out[0].startMs).toBe(0);
  });

  it('drops a weaker overtone that rings inside a longer note', () => {
    const out = resolveOverlaps([note(28, 0, 1000, 0.8), note(40, 300, 600, 0.5)]);
    expect(out).toEqual([note(28, 0, 1000, 0.8)]);
  });

  it('cuts a ringing note off when the next note is plucked', () => {
    // E then A, with E still sounding when A starts — legato, the most ordinary case.
    const out = resolveOverlaps([note(28, 0, 600), note(33, 500, 1000)]);
    expect(out).toEqual([note(28, 0, 500), note(33, 500, 1000)]);
  });

  it('keeps a real octave jump that is plucked, not rung', () => {
    // Longer than the note it overlaps, so it is not contained: the player went up.
    const out = resolveOverlaps([note(28, 0, 600), note(40, 400, 1200)]);
    expect(out.map((n) => n.midi)).toEqual([28, 40]);
    expect(out[0].endMs).toBe(400);
  });

  it('keeps repeated same-pitch notes apart', () => {
    // basic-pitch reports each re-pluck; overlapping tails must not swallow them.
    const out = resolveOverlaps([note(33, 0, 520), note(33, 500, 1020), note(33, 1000, 1500)]);
    expect(out).toHaveLength(3);
    expect(out.map((n) => n.startMs)).toEqual([0, 500, 1000]);
  });

  it('leaves non-overlapping input alone and does not mutate it', () => {
    const input = [note(28, 0, 400), note(33, 500, 900)];
    const copy = structuredClone(input);
    expect(resolveOverlaps(input)).toEqual(copy);
    expect(input).toEqual(copy);
  });

  it('writes one tab note per pluck when basic-pitch also hears the octave', () => {
    // The case that used to double the notes: eight quarter notes on A1 at 120 BPM, each
    // reported together with its octave. The tab must read 0.3 eight times and nothing else.
    const notes: DetectedNote[] = [];
    for (let i = 0; i < 8; i++) {
      notes.push(note(33, i * 500, i * 500 + 450, 0.8));
      notes.push(note(45, i * 500 + 5, i * 500 + 300, 0.4));
    }
    const result = notesToAutoTab({ notes, durationMs: 4000, title: 't', bpm: 120, engine: 'basic-pitch' });
    expect(result.noteCount).toBe(8);
    const body = result.alphaTex.split('\n').filter((l) => /^[:r\d]/.test(l));
    expect(body.slice(0, 2)).toEqual([':4 0.3 0.3 0.3 0.3 |', '0.3 0.3 0.3 0.3 |']);
  });
});

describe('dropOvertones', () => {
  const note = (midi: number, startMs: number, endMs: number, confidence = 0.6): DetectedNote => ({
    midi,
    startMs,
    endMs,
    confidence,
  });

  it('removes overtones that straddle a note the model split in two', () => {
    // Measured from basic-pitch on a plucked A1: one note, reported as four.
    const out = dropOvertones([
      note(33, 1242, 1416, 0.608),
      note(52, 1312, 1556, 0.329),
      note(45, 1335, 1498, 0.33),
      note(33, 1416, 1649, 0.693),
    ]);
    expect(out.map((n) => n.midi)).toEqual([33, 33]);
  });

  it('keeps an upper note the model was surer of than the one under it', () => {
    const out = dropOvertones([note(33, 0, 500, 0.3), note(45, 100, 400, 0.8)]);
    expect(out).toHaveLength(2);
  });

  it('keeps an octave note that merely touches a lower one', () => {
    // A real octave jump: the upper note mostly sounds after the lower one has ended.
    const out = dropOvertones([note(28, 0, 500, 0.7), note(40, 450, 950, 0.5)]);
    expect(out).toHaveLength(2);
  });

  it('ignores intervals that are not overtones', () => {
    const out = dropOvertones([note(33, 0, 500, 0.7), note(40, 100, 400, 0.3)]);
    expect(out).toHaveLength(2);
  });
});

describe('attackEnvelope / refineWithEnvelope', () => {
  const RATE = 22050;
  /** Plucks of a decaying tone at the given times (ms), each lasting `lengthMs`. */
  function plucks(timesMs: number[], lengthMs = 440, totalMs = 3000, hz = 55): Float32Array {
    const out = new Float32Array(Math.round((totalMs / 1000) * RATE));
    for (const t0 of timesMs) {
      const start = Math.round((t0 / 1000) * RATE);
      const len = Math.round((lengthMs / 1000) * RATE);
      for (let i = 0; i < len && start + i < out.length; i++) {
        out[start + i] = Math.exp((-2.5 * i) / RATE) * 0.8 * Math.sin((2 * Math.PI * hz * i) / RATE);
      }
    }
    return out;
  }
  const note = (midi: number, startMs: number, endMs: number): DetectedNote => ({
    midi,
    startMs,
    endMs,
    confidence: 0.6,
  });

  it('puts the attack where the string was plucked', () => {
    const env = attackEnvelope(plucks([1000]), RATE);
    let best = 0;
    for (let i = 1; i < env.riseDb.length; i++) if (env.riseDb[i] > env.riseDb[best]) best = i;
    expect(Math.abs(best * env.hopMs - 1000)).toBeLessThanOrEqual(10);
  });

  it('moves an onset the model reported early onto the real attack', () => {
    // basic-pitch put a plucked E1 about 100ms before it was played.
    const env = attackEnvelope(plucks([1000], 440, 3000, 41.2), RATE);
    const [moved] = refineWithEnvelope([note(28, 900, 1440)], env);
    expect(Math.abs(moved.startMs - 1000)).toBeLessThanOrEqual(10);
  });

  it('joins a note the model cut in two where nothing was re-plucked', () => {
    const env = attackEnvelope(plucks([1000]), RATE);
    const out = refineWithEnvelope([note(33, 1000, 1150), note(33, 1150, 1440)], env);
    expect(out).toHaveLength(1);
    expect(out[0].endMs).toBe(1440);
  });

  it('keeps genuinely repeated notes apart — each one was plucked', () => {
    const env = attackEnvelope(plucks([1000, 1250, 1500, 1750], 240), RATE);
    const out = refineWithEnvelope(
      [note(33, 1000, 1250), note(33, 1250, 1500), note(33, 1500, 1750), note(33, 1750, 1990)],
      env,
    );
    expect(out).toHaveLength(4);
    // Within the envelope's 5ms resolution of each pluck.
    out.forEach((n, i) => expect(Math.abs(n.startMs - (1000 + i * 250))).toBeLessThanOrEqual(5));
  });

  it('leaves an onset alone when there is no attack near it (legato)', () => {
    const env = attackEnvelope(new Float32Array(RATE * 2).fill(0.2), RATE);
    const [kept] = refineWithEnvelope([note(33, 700, 1100)], env);
    expect(kept.startMs).toBe(700);
  });
});

describe('repairOctaveJumps', () => {
  const note = (midi: number, startMs: number, endMs: number): DetectedNote => ({
    midi,
    startMs,
    endMs,
    confidence: 0.9,
  });

  it('pulls a brief harmonic slip back down', () => {
    // The exact shape seen on a real transcription: a short D3 sitting inside a run of D2s,
    // contiguous with both, from YIN latching onto the second harmonic.
    const fixed = repairOctaveJumps([
      note(38, 0, 220),
      note(50, 230, 400),
      note(38, 410, 800),
    ]);
    expect(fixed.map((n) => n.midi)).toEqual([38, 38, 38]);
  });

  it('leaves a real octave leap alone', () => {
    // E1 E2 E1 with all three the same length is a bass player playing octaves, and rewriting
    // it would delete the most recognisable thing about the line.
    const played = [note(28, 0, 240), note(40, 250, 490), note(28, 500, 740)];
    expect(repairOctaveJumps(played).map((n) => n.midi)).toEqual([28, 40, 28]);
  });

  it('leaves a leap that is separated in time alone', () => {
    // A gap means a re-attack, not a detector slip inside one sustained note.
    const played = [note(38, 0, 400), note(50, 900, 1000), note(38, 1500, 1900)];
    expect(repairOctaveJumps(played).map((n) => n.midi)).toEqual([38, 50, 38]);
  });

  it('leaves a slip that would not land near its neighbours alone', () => {
    // Dropping an octave has to explain the note. If it does not, this is real playing and
    // guessing at it would invent a note nobody played.
    const played = [note(33, 0, 300), note(52, 310, 380), note(35, 390, 700)];
    expect(repairOctaveJumps(played).map((n) => n.midi)).toEqual([33, 52, 35]);
  });
});

describe('searchTempo', () => {
  const onsetsAt = (bpm: number, offsetMs: number, slots: number[]): DetectedNote[] => {
    const six = 60000 / bpm / 4;
    return slots.map((k) => ({
      midi: 33,
      startMs: offsetMs + k * six,
      endMs: offsetMs + k * six + six * 0.8,
      confidence: 0.9,
    }));
  };

  // Gaps of two, three and four sixteenths in the proportions a real bass line has. The
  // median gap is three — a dotted eighth, a value the tempo is not built from.
  const MIXED = ((): number[] => {
    const gaps = [2, 4, 2, 3, 4, 3, 2, 4, 3, 4, 2, 3, 4, 3, 2, 4, 3, 2, 4, 3, 3, 2, 4, 3];
    const slots = [0];
    for (const g of gaps) slots.push(slots[slots.length - 1] + g);
    return slots;
  })();

  it('finds the tempo of a line mixing note values', () => {
    const found = searchTempo(onsetsAt(146, 60, MIXED));
    expect(found.bpm).toBeCloseTo(146, 0);
    expect(found.strength).toBeGreaterThan(0.9);
  });

  it('the median-of-gaps estimate it replaced misses that case', () => {
    // Kept as a test so the reason for the extra machinery stays visible: this is not a
    // hypothetical weakness, it is the measured behaviour of the simpler approach on the
    // shape of input that actually turns up.
    expect(Math.abs(estimateBpm(onsetsAt(146, 60, MIXED)) - 146)).toBeGreaterThan(10);
  });

  it('reports weak lock for onsets that have no grid', () => {
    // The honesty requirement. A tempo is always returned; this number is what says whether
    // it was found or merely produced.
    const random = [113, 391, 555, 811, 1207, 1499, 1888, 2301, 2777, 3010].map((t) => ({
      midi: 33,
      startMs: t,
      endMs: t + 90,
      confidence: 0.9,
    }));
    expect(searchTempo(random).strength).toBeLessThan(0.5);
  });

  it('prefers the reading a musician would write when the octave is ambiguous', () => {
    // Onsets every 205ms fit 73 BPM (sixteenths) and 146 BPM (eighths) equally well, because
    // they are the same grid. 146 with eighths is the conventional notation.
    const every205 = Array.from({ length: 24 }, (_, i) => ({
      midi: 33,
      startMs: i * 205.48,
      endMs: i * 205.48 + 150,
      confidence: 0.9,
    }));
    expect(searchTempo(every205).bpm).toBeCloseTo(146, 0);
  });

  it('survives human timing jitter', () => {
    const notes = onsetsAt(132, 0, Array.from({ length: 24 }, (_, i) => i * 2)).map((n, i) => ({
      ...n,
      startMs: n.startMs + ((i * 37) % 13) - 6,
    }));
    expect(searchTempo(notes).bpm).toBeCloseTo(132, 0);
  });
});

describe('the tempo the beat is cut into', () => {
  /** A riff whose pitches repeat every two bars, played on a grid of `slotMs`. */
  const riff = (slotMs: number, slotsPerBar: number, bars: number): DetectedNote[] => {
    const shape = [40, 40, 28, 33, 33, 28, 33, 33];
    const out: DetectedNote[] = [];
    for (let bar = 0; bar < bars; bar++) {
      for (let i = 0; i < slotsPerBar; i++) {
        const start = (bar * slotsPerBar + i) * slotMs;
        out.push({
          midi: shape[(bar % 2) * 4 + (i % 4)],
          startMs: start,
          endMs: start + slotMs * 0.8,
          confidence: 0.9,
        });
      }
    }
    return out;
  };

  it('reads an eighth-note grid as 146 BPM, not 109.5', () => {
    // Green Day's "Holiday". Every onset is an eighth at 146, so the smallest grid present is
    // 205ms — and 205ms cannot be a sixteenth of anything between 60 and 200 BPM except by
    // calling it a *triplet* of 109.8. The old search could only describe a grid as beat/4,
    // so that is exactly what it did: it reported 109.77 for a song marked 146, and put every
    // bar line three quarters of the way to where it belonged.
    const notes = riff(60000 / 146 / 2, 8, 16);
    const found = searchTempo(notes);
    expect(found.bpm).toBeCloseTo(146, 0);
    expect(found.subdivision).toBe(4);
  });

  it('still reads a sixteenth-note grid as the same 146 BPM', () => {
    const notes = riff(60000 / 146 / 4, 16, 12);
    expect(searchTempo(notes).bpm).toBeCloseTo(146, 0);
  });

  it('reads a shuffle as its real tempo with the beat cut in three', () => {
    // Triplet eighths at 132: the slot is a third of a beat, not a quarter. Called straight
    // it would come out at 99 BPM — the same three-quarters error, from the other direction.
    const notes = riff(60000 / 132 / 3, 12, 16);
    const found = searchTempo(notes);
    expect(found.bpm).toBeCloseTo(132, 0);
    expect(found.subdivision).toBe(3);
  });

  it('does not invent a shuffle in straight time', () => {
    // Any straight grid can also be described as a slower one cut in three, so the shuffle
    // reading is always on the table. It has to be earned.
    expect(searchTempo(riff(60000 / 120 / 4, 16, 12)).subdivision).toBe(4);
  });
});

describe('findRepeatPeriodMs', () => {
  const line = (pitches: number[], slotMs: number, repeats: number): DetectedNote[] => {
    const out: DetectedNote[] = [];
    for (let r = 0; r < repeats; r++) {
      pitches.forEach((midi, i) => {
        const start = (r * pitches.length + i) * slotMs;
        out.push({ midi, startMs: start, endMs: start + slotMs * 0.9, confidence: 0.9 });
      });
    }
    return out;
  };

  it('finds how long the riff is', () => {
    const period = findRepeatPeriodMs(line([40, 43, 45, 40, 38, 40, 43, 45], 250, 10));
    expect(period).toBeCloseTo(2000, -2);
  });

  it('refuses to read a phrase length out of one repeated note', () => {
    // A line that stays on one note matches itself perfectly at every lag. Returning the
    // first of those as "the riff length" is a confident, meaningless number — and it steered
    // a real tempo decision wrong before this guard existed.
    expect(findRepeatPeriodMs(line([40, 40, 40, 40], 250, 20))).toBe(0);
  });

  it('finds a long phrase rather than settling for a short one', () => {
    // This sequence only comes back around after 24 notes — six seconds. Writing the test
    // the lazy way, with a pattern I assumed did not repeat, taught me it did: 7 and 24 are
    // coprime, so it cycles. The function was right and the test was wrong.
    const cycling = Array.from({ length: 96 }, (_, i) => ({
      midi: 28 + ((i * 7) % 24),
      startMs: i * 250,
      endMs: i * 250 + 220,
      confidence: 0.9,
    }));
    expect(findRepeatPeriodMs(cycling)).toBeCloseTo(6000, -2);
  });
});

describe('fillDurations', () => {
  const q = (start: number, length: number) => ({
    midi: 33,
    startMs: 0,
    endMs: 0,
    confidence: 0.9,
    startSixteenths: start,
    lengthSixteenths: length,
  });

  it('holds a note until the next one starts', () => {
    // A plucked bass note decays, so the detector always cuts it early and the leftover
    // became a rest — a rest between every single note, which is nothing like how bass is
    // written. This is the difference between confetti and a readable tab.
    const filled = fillDurations([q(0, 1), q(4, 1), q(8, 1)]);
    expect(filled.map((n) => n.lengthSixteenths)).toEqual([4, 4, 1]);
  });

  it('leaves a real silence alone', () => {
    // A bar the bassist sits out has to stay a bar of rest, or the tab claims a note rang
    // through it.
    const filled = fillDurations([q(0, 2), q(32, 2)]);
    expect(filled[0].lengthSixteenths).toBe(2);
  });

  it('never shortens a note that already reaches the next one', () => {
    const filled = fillDurations([q(0, 4), q(4, 4)]);
    expect(filled.map((n) => n.lengthSixteenths)).toEqual([4, 4]);
  });
});

describe('gridPhase', () => {
  it('finds the phase of a known tempo', () => {
    const six = 60000 / 120 / 4;
    const notes = [0, 4, 8, 12, 16, 20, 24, 28].map((k) => ({
      midi: 33,
      startMs: 40 + k * six,
      endMs: 40 + k * six + 100,
      confidence: 0.9,
    }));
    const phase = gridPhase(notes, 120);
    expect(phase.offsetMs).toBeCloseTo(40, 0);
    expect(phase.meanAbsErrorMs).toBeLessThan(1);
    expect(phase.strength).toBeGreaterThan(0.99);
  });

  it('wraps around the slot rather than averaging across it', () => {
    // Onsets straddling the slot boundary — some a hair early, some a hair late. A signed
    // average of the residuals lands in the middle of the slot, the worst possible answer;
    // circular mean sees them as the tight cluster they are.
    const six = 60000 / 120 / 4;
    const notes = [0, 4, 8, 12, 16, 20].map((k, i) => ({
      midi: 33,
      startMs: k * six + (i % 2 === 0 ? 3 : -3),
      endMs: k * six + 100,
      confidence: 0.9,
    }));
    expect(gridPhase(notes, 120).meanAbsErrorMs).toBeLessThan(4);
  });

  it('reports a grid just before the beat as negative, not as nearly a whole slot late', () => {
    // Onsets 2ms early. Wrapped into [0, slot) this came out as +123ms, and every note was
    // written one sixteenth early against the recording.
    const six = 60000 / 120 / 4;
    const notes = [6, 10, 14, 18, 22, 26].map((k) => ({
      midi: 33,
      startMs: k * six - 2,
      endMs: k * six + 400,
      confidence: 0.9,
    }));
    const phase = gridPhase(notes, 120);
    expect(phase.offsetMs).toBeCloseTo(-2, 0);
    const placed = quantizeNotes(notes, 120, phase.offsetMs);
    expect(placed.map((n) => n.startSixteenths)).toEqual([6, 10, 14, 18, 22, 26]);
  });
});

describe('fitGrid', () => {
  const onsets = (bpm: number, offsetMs: number, slots: number[]): DetectedNote[] => {
    const six = 60000 / bpm / 4;
    return slots.map((k) => ({
      midi: 33,
      startMs: offsetMs + k * six,
      endMs: offsetMs + k * six + six * 0.8,
      confidence: 0.9,
    }));
  };

  it('recovers tempo and phase from a wrong initial guess', () => {
    // True grid: 100 BPM, phase +37ms. Initial guess 5% off.
    const notes = onsets(100, 37, [0, 2, 4, 6, 8, 12, 16, 20, 24, 28]);
    const fit = fitGrid(notes, 95);
    expect(fit.bpm).toBeCloseTo(100, 1);
    expect(fit.offsetMs).toBeCloseTo(37, 0);
    expect(fit.meanAbsErrorMs).toBeLessThan(1);
  });

  it('a 1% tempo error would have drifted — the fit brings it home', () => {
    // 40 bars of quarter notes at 120 BPM. With the guess left at 118.8 the last onsets sit
    // ~800ms off-grid; after fitting they are back within a few ms.
    const notes = onsets(120, 0, Array.from({ length: 40 }, (_, i) => i * 4));
    const fit = fitGrid(notes, 118.8);
    expect(fit.bpm).toBeCloseTo(120, 1);
    expect(fit.meanAbsErrorMs).toBeLessThan(2);
  });

  it('fits only the phase when the BPM is pinned', () => {
    const notes = onsets(100, 42, [0, 4, 8, 12, 16]);
    const fit = fitGrid(notes, 100, { fixedBpm: true });
    expect(fit.bpm).toBe(100);
    expect(fit.offsetMs).toBeCloseTo(42, 0);
  });

  it('tolerates human timing jitter', () => {
    const jitter = [5, -7, 3, -4, 6, -2, 4, -6, 2, -3];
    const notes = onsets(110, 20, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]).map((n, i) => ({
      ...n,
      startMs: n.startMs + jitter[i],
    }));
    const fit = fitGrid(notes, 107);
    expect(fit.bpm).toBeCloseTo(110, 0);
    expect(fit.meanAbsErrorMs).toBeLessThan(10);
  });

  it('falls back to the guess with too few notes', () => {
    const fit = fitGrid(onsets(100, 0, [0, 4]), 100);
    expect(fit.bpm).toBe(100);
  });

  it('refuses a fit that wandered out of musical range', () => {
    // Random onsets have no grid; whatever the regression finds must not replace the guess
    // with something absurd.
    const notes = [113, 391, 555, 811, 1207].map((t) => ({
      midi: 33,
      startMs: t,
      endMs: t + 90,
      confidence: 0.9,
    }));
    const fit = fitGrid(notes, 120);
    expect(fit.bpm).toBeGreaterThanOrEqual(40);
    expect(fit.bpm).toBeLessThanOrEqual(300);
  });
});

describe('quantizeNotes', () => {
  const at120 = (notes: DetectedNote[]) => quantizeNotes(notes, 120);
  // At 120 BPM a quarter note is 500ms and a sixteenth is 125ms.

  it('snaps a quarter note to four sixteenths', () => {
    const [note] = at120([{ midi: 33, startMs: 0, endMs: 500, confidence: 1 }]);
    expect(note.startSixteenths).toBe(0);
    expect(note.lengthSixteenths).toBe(4);
  });

  it('snaps an eighth note to two sixteenths', () => {
    const [note] = at120([{ midi: 33, startMs: 0, endMs: 250, confidence: 1 }]);
    expect(note.lengthSixteenths).toBe(2);
  });

  it('places an onset on the right beat', () => {
    const [note] = at120([{ midi: 33, startMs: 1000, endMs: 1500, confidence: 1 }]);
    expect(note.startSixteenths).toBe(8); // two beats in
  });

  it('forgives a slightly early or late onset', () => {
    const [early] = at120([{ midi: 33, startMs: 480, endMs: 980, confidence: 1 }]);
    const [late] = at120([{ midi: 33, startMs: 520, endMs: 1020, confidence: 1 }]);
    expect(early.startSixteenths).toBe(4);
    expect(late.startSixteenths).toBe(4);
  });

  it('always produces a length alphaTex can write', () => {
    const messy = [
      { midi: 33, startMs: 0, endMs: 137, confidence: 1 },
      { midi: 35, startMs: 300, endMs: 1130, confidence: 1 },
      { midi: 37, startMs: 1500, endMs: 1560, confidence: 1 },
    ];
    for (const note of at120(messy)) {
      expect([1, 2, 4, 8, 16]).toContain(note.lengthSixteenths);
    }
  });

  it('never lets a note start before the previous one ends', () => {
    const overlapping = [
      { midi: 33, startMs: 0, endMs: 500, confidence: 1 },
      { midi: 35, startMs: 60, endMs: 560, confidence: 1 },
    ];
    const [first, second] = at120(overlapping);
    expect(second.startSixteenths).toBeGreaterThanOrEqual(
      first.startSixteenths + first.lengthSixteenths,
    );
  });

  it('rejects a nonsense tempo', () => {
    expect(() => quantizeNotes([], 0)).toThrow(/BPM/);
  });
});

describe('mapToFretboard', () => {
  const quantized = (midis: number[]) =>
    quantizeNotes(
      midis.map((midi, i) => ({ midi, startMs: i * 500, endMs: i * 500 + 400, confidence: 1 })),
      120,
    );

  it('puts open strings on fret 0', () => {
    const fretted = mapToFretboard(quantized(BASS_TUNING));
    expect(fretted.map((f) => f.fret)).toEqual([0, 0, 0, 0]);
  });

  it('numbers strings the way alphaTab does — low E is string 4', () => {
    const [lowE] = mapToFretboard(quantized([28]));
    expect(lowE.string).toBe(4);
    const [highG] = mapToFretboard(quantized([43]));
    expect(highG.string).toBe(1);
  });

  it('produces the pitch it was asked for', () => {
    const midis = [28, 31, 35, 40, 45, 50, 55];
    for (const note of mapToFretboard(quantized(midis))) {
      // string 4 is tuning index 0, string 1 is index 3
      const openMidi = BASS_TUNING[BASS_TUNING.length - note.string];
      expect(openMidi + note.fret).toBe(note.midi);
    }
  });

  it('keeps the hand in one place instead of chasing low frets', () => {
    // After a note high on the E string, the next note is reachable on two strings; the one
    // near the hand should win even though the alternative has a lower fret number.
    const fretted = mapToFretboard(quantized([40, 45]));
    expect(Math.abs(fretted[1].fret - fretted[0].fret)).toBeLessThanOrEqual(5);
  });

  it('drops notes the instrument cannot reach', () => {
    expect(mapToFretboard(quantized([20]))).toHaveLength(0);
  });

  it('stays within 20 frets', () => {
    for (const note of mapToFretboard(quantized([28, 40, 55, 63]))) {
      expect(note.fret).toBeGreaterThanOrEqual(0);
      expect(note.fret).toBeLessThanOrEqual(20);
    }
  });
});

describe('toAlphaTex', () => {
  const build = (midis: number[], minBars = 1) => {
    const notes = mapToFretboard(
      quantizeNotes(
        midis.map((midi, i) => ({ midi, startMs: i * 500, endMs: i * 500 + 450, confidence: 1 })),
        120,
      ),
    );
    return toAlphaTex(notes, { title: 'T', bpm: 120, minBars });
  };

  it('emits a header alphaTab can parse', () => {
    const tex = build([33]);
    expect(tex).toContain('\\title "T"');
    expect(tex).toContain('\\tempo 120');
    expect(tex).toContain('\\tuning G2 D2 A1 E1');
    expect(tex).toContain('\\staff{tabs}');
  });

  it('writes fret.string pairs', () => {
    expect(build([28])).toMatch(/\b0\.4\b/);
  });

  it('fills every bar completely', () => {
    const tex = build([33, 35, 37, 38]);
    const bars = tex.split('\n').filter((l) => l.trim().endsWith('|'));
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      // Sum the durations in the bar and check they add to a whole 4/4 measure.
      let sixteenths = 0;
      let token = 4;
      for (const part of bar.replace('|', '').trim().split(/\s+/)) {
        if (part.startsWith(':')) token = Number(part.slice(1));
        else sixteenths += 16 / token;
      }
      expect(sixteenths).toBe(16);
    }
  });

  it('pads out to the requested minimum length', () => {
    const tex = build([33], 8);
    expect(tex.split('\n').filter((l) => l.trim().endsWith('|')).length).toBe(8);
  });

  it('writes rests where nothing was detected', () => {
    expect(build([33], 4)).toMatch(/\br\b/);
  });

  it('groups silence into big rests instead of a wall of sixteenths', () => {
    // An empty bar used to render as sixteen individual sixteenth rests, which made sparse
    // passages unreadable. It must collapse to a single whole rest.
    const tex = toAlphaTex([], { title: 'T', bpm: 120, minBars: 3 });
    const bars = tex.split('\n').filter((l) => l.trim().endsWith('|'));
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      const glyphs = bar.replace('|', '').trim().split(/\s+/).filter((t) => !t.startsWith(':'));
      expect(glyphs).toEqual(['r']);
    }
  });

  it('still fills bars exactly when rests are grouped around notes', () => {
    // One note on beat 3 of bar 1: the leading silence and the tail must still sum to a bar.
    const notes = mapToFretboard(
      quantizeNotes([{ midi: 33, startMs: 1000, endMs: 1450, confidence: 1 }], 120),
    );
    const tex = toAlphaTex(notes, { title: 'T', bpm: 120, minBars: 1 });
    const bar = tex.split('\n').find((l) => l.trim().endsWith('|'))!;
    let sixteenths = 0;
    let token = 4;
    for (const part of bar.replace('|', '').trim().split(/\s+/)) {
      if (part.startsWith(':')) token = Number(part.slice(1));
      else sixteenths += 16 / token;
    }
    expect(sixteenths).toBe(16);
    // And the leading 8-slot silence must be two grouped rests at most, not eight sixteenths.
    const glyphsBeforeNote = bar.split('0.3')[0].split(/\s+/).filter((t) => t === 'r').length;
    expect(glyphsBeforeNote).toBeLessThanOrEqual(2);
  });

  it('strips quotes and backslashes from the title so the header stays valid', () => {
    // Only the two characters that would break the header are removed; spacing survives.
    const tex = toAlphaTex([], { title: 'a "b" \\c', bpm: 100, minBars: 1 });
    expect(tex).toContain('\\title "a b c"');
    // Pull the title back out and check its contents, rather than pattern-matching the whole
    // line — the title's own closing quote makes that far too easy to get wrong.
    const inner = /\\title "(.*)"/.exec(tex)?.[1] ?? '';
    expect(inner).not.toMatch(/["\\]/);
  });
});

describe('estimateBpm', () => {
  it('falls back when there is nothing to go on', () => {
    expect(estimateBpm([], 130)).toBe(130);
  });

  it('recovers a steady quarter-note pulse', () => {
    // 500ms apart is 120 BPM.
    const notes: DetectedNote[] = Array.from({ length: 8 }, (_, i) => ({
      midi: 33,
      startMs: i * 500,
      endMs: i * 500 + 400,
      confidence: 1,
    }));
    expect(estimateBpm(notes)).toBe(120);
  });

  it('folds an implausible tempo into range', () => {
    // 125ms apart is 480 BPM as written; halving twice lands on a sane 120.
    const notes: DetectedNote[] = Array.from({ length: 8 }, (_, i) => ({
      midi: 33,
      startMs: i * 125,
      endMs: i * 125 + 100,
      confidence: 1,
    }));
    const bpm = estimateBpm(notes);
    expect(bpm).toBeGreaterThanOrEqual(60);
    expect(bpm).toBeLessThanOrEqual(200);
  });
});
