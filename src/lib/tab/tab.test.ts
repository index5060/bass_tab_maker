import { describe, expect, it } from 'vitest';
import { analyseTab, transcribeTab, writeTabFrom } from './index';
import { onsetStrength, trackBeats } from './beats';
import { findBeats } from './tempo';
import { decodeBassLine } from './notes';
import { findMeter } from './meter';
import { assignFrets, BASS_TUNING } from './frets';
import { writeTab } from './write';
import { toMonoSamples } from './decode';
import { fft } from './spectrum';

const SR = 44100;
const midiHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A plucked bass note: fundamental and two harmonics, decaying, muted just before the next. */
function pluck(out: Float32Array, at: number, seconds: number, midi: number, amplitude = 0.3): void {
  const start = Math.round(at * SR);
  const length = Math.round(seconds * SR);
  const hz = midiHz(midi);
  for (let i = 0; i < length && start + i < out.length; i++) {
    const t = i / SR;
    const envelope = Math.exp(-3 * t) * (i > length * 0.9 ? 0 : 1);
    out[start + i] +=
      envelope * amplitude * (Math.sin(2 * Math.PI * hz * t) + 0.45 * Math.sin(4 * Math.PI * hz * t) + 0.2 * Math.sin(6 * Math.PI * hz * t));
  }
}

/** A drum hit: a burst of noise, low (kick) or high (snare). Deterministic. */
function hit(out: Float32Array, at: number, kind: 'kick' | 'snare', amplitude = 0.4): void {
  const start = Math.round(at * SR);
  let seed = start + (kind === 'kick' ? 1 : 2);
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const length = Math.round(0.12 * SR);
  for (let i = 0; i < length && start + i < out.length; i++) {
    const t = i / SR;
    const v = kind === 'kick' ? Math.sin(2 * Math.PI * 60 * t) * Math.exp(-25 * t) : random() * Math.exp(-30 * t);
    out[start + i] += amplitude * v;
  }
}

/** A band: kick on 1 and 3, snare on 2 and 4, starting `lead` seconds in. */
function rockBeat(seconds: number, bpm: number, lead: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const beat = 60 / bpm;
  for (let k = 0; lead + k * beat < seconds - 0.2; k++) hit(out, lead + k * beat, k % 2 === 0 ? 'kick' : 'snare');
  return out;
}

describe('fft', () => {
  it('finds a pure tone in its bin', () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    fft(re, im);
    const magnitude = Array.from(re, (r, i) => Math.hypot(r, im[i]));
    expect(magnitude[5]).toBeCloseTo(n / 2, 6);
    expect(magnitude[7]).toBeLessThan(1e-9);
  });
});

describe('beats', () => {
  it('tracks a steady drum beat and finds its tempo', () => {
    const band = rockBeat(12, 120, 0.3);
    const onset = onsetStrength(band, SR);
    const track = findBeats(onset, 12, { drums: true });
    expect(track.bpm).toBeGreaterThan(118);
    expect(track.bpm).toBeLessThan(122);
    // Every tracked beat sits on a drum hit (well inside a sixteenth, 125ms here).
    for (const t of track.beats.slice(track.firstTracked, track.lastTracked + 1)) {
      const k = Math.round((t - 0.3) / 0.5);
      expect(Math.abs(t - (0.3 + k * 0.5))).toBeLessThan(0.045);
    }
  });

  it('extends the grid over the whole recording', () => {
    const band = rockBeat(10, 100, 1.5);
    const onset = onsetStrength(band, SR);
    const track = trackBeats(onset, 10);
    expect(track.beats[0]).toBeLessThan(0.6);
    expect(track.beats[track.beats.length - 1]).toBeGreaterThan(9.4);
  });
});

describe('notes on the beat grid', () => {
  const beats = Array.from({ length: 12 }, (_, k) => 0.5 + k * 0.5);

  it('reads one note per pluck, repeated notes included', () => {
    const bass = new Float32Array(SR * 7);
    const line = [33, 33, 40, 38, 33, 33, 28, 31];
    line.forEach((midi, k) => pluck(bass, 0.5 + k * 0.5, 0.5, midi));
    const decoded = decodeBassLine(bass, SR, beats);
    expect(decoded.notes.map((n) => n.midi)).toEqual(line);
    // Each one starts on its beat (slot = beat x 4).
    expect(decoded.notes.map((n) => n.startSlot)).toEqual(line.map((_, k) => k * 4));
  });

  it('places a note between beats on its sixteenth', () => {
    const bass = new Float32Array(SR * 4);
    pluck(bass, 0.5, 0.375, 33);
    pluck(bass, 0.875, 0.625, 36); // the "a" of beat 1: three sixteenths in
    const decoded = decodeBassLine(bass, SR, beats);
    expect(decoded.notes.map((n) => [n.startSlot, n.midi])).toEqual([
      [0, 33],
      [3, 36],
    ]);
  });

  it('measures how far the recording sits from A=440', () => {
    const bass = new Float32Array(SR * 4);
    const sharp = (midi: number) => midi + 0.3; // 30 cents sharp
    [33, 36, 38, 40].forEach((midi, k) => pluck(bass, 0.5 + k * 0.5, 0.5, sharp(midi)));
    const decoded = decodeBassLine(bass, SR, beats);
    expect(decoded.notes.map((n) => n.midi)).toEqual([33, 36, 38, 40]);
    expect(decoded.tuningCents).toBeGreaterThan(20);
    expect(decoded.tuningCents).toBeLessThan(40);
  });
});

describe('metre', () => {
  it('puts "one" on the kick that starts each bar, and the snare on 2 and 4', () => {
    // Beats from 0.3s; the band's bar starts on the third beat of the list (index 2).
    const bpm = 120;
    const lead = 0.3;
    const band = new Float32Array(SR * 12);
    for (let k = 0; lead + k * 0.5 < 11.8; k++) {
      const inBar = (k - 2 + 400) % 4;
      if (inBar === 0) hit(band, lead + k * 0.5, 'kick');
      if (inBar === 1 || inBar === 3) hit(band, lead + k * 0.5, 'snare');
    }
    const onset = onsetStrength(band, SR);
    const beats = Array.from({ length: 23 }, (_, k) => lead + (k * 60) / bpm);
    const meter = findMeter(beats, [], 4, onset, { first: 0, last: beats.length - 1 });
    expect(meter.beatsPerBar).toBe(4);
    expect(meter.downbeatPhase % 4).toBe(2);
  });
});

describe('frets', () => {
  const at = (midis: number[]) => midis.map((midi, i) => ({ startSlot: i * 2, endSlot: i * 2 + 2, midi, confidence: 1 }));
  const written = (midis: number[]) => assignFrets(at(midis)).map((n) => `${n.fret}.${n.string}`);

  it('plays open-string pitches on open strings', () => {
    expect(written([28, 33, 38, 43, 28, 33, 38, 43])).toEqual(['0.4', '0.3', '0.2', '0.1', '0.4', '0.3', '0.2', '0.1']);
  });

  it('keeps a root line on the low strings, shifting while an open string rings', () => {
    // F2 F2 A1 Db2 Db2 A1 | Ab1 Ab1 E1 Eb2 x4 A1 — the way the published tab of a well-known
    // punk song fingers it: A8, A4, E4, A6 with open strings between.
    expect(written([41, 41, 33, 37, 37, 33, 32, 32, 28, 39, 39, 39, 39, 33])).toEqual([
      '8.3', '8.3', '0.3', '4.3', '4.3', '0.3', '4.4', '4.4', '0.4', '6.3', '6.3', '6.3', '6.3', '0.3',
    ]);
  });

  it('plays an octave with the octave shape', () => {
    expect(written([28, 28, 40, 31])).toEqual(['0.4', '0.4', '2.2', '3.4']);
  });

  it('drops what a 4-string bass cannot play', () => {
    expect(assignFrets(at([20, 33]))).toHaveLength(1);
    expect(BASS_TUNING).toEqual([28, 33, 38, 43]);
  });
});

describe('writer', () => {
  const beats = Array.from({ length: 13 }, (_, k) => 1 + k * 0.5); // 120 BPM, bar 1 at 1s
  const note = (startSlot: number, endSlot: number, fret: number, string: number) => ({
    startSlot,
    endSlot,
    midi: BASS_TUNING[4 - string] + fret,
    confidence: 1,
    fret,
    string,
  });

  it('writes values, rests on beats, ties over the bar line, and one anchor per bar', () => {
    const result = writeTab({
      title: 'Test',
      notes: [note(0, 4, 0, 3), note(4, 6, 3, 3), note(8, 11, 5, 3), note(14, 20, 0, 4)],
      beats,
      beatsPerBar: 4,
      subdivision: 4,
      trackedBeats: { first: 0, last: 12 },
    });
    const bars = result.alphaTex.split('\n').filter((l) => l.endsWith('|'));
    // Gaps under a beat are closed (a plucked note is written until the next one), so the
    // eighth becomes a quarter and the 3/16 a dotted quarter; the last note ties into bar 2,
    // and the rest of that bar is one dotted half.
    expect(bars[0]).toBe('\\ts (4 4) :4 0.3 3.3 5.3{d} :8 0.4 |');
    expect(bars[1]).toBe(':4 -.4 :2 r{d} |');
    expect(result.bpm).toBe(120);
    expect(result.anchors.map((a) => [a.barIndex, a.tick, a.audioMs])).toEqual([
      [0, 0, 1000],
      [1, 3840, 3000],
      [2, 7680, 5000],
    ]);
  });

  it('writes a tempo change only where the band really moved', () => {
    const drifting = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.4, 5.8, 6.2, 6.6, 7];
    const result = writeTab({
      title: 'Drift',
      notes: [note(0, 4, 0, 3)],
      beats: drifting,
      beatsPerBar: 4,
      subdivision: 4,
      trackedBeats: { first: 0, last: drifting.length - 1 },
    });
    expect(result.alphaTex).toContain('\\tempo 120\n');
    expect(result.alphaTex).toContain('\\tempo 150 ');
  });
});

describe('the whole thing', () => {
  /**
   * A band and a bass line over it: the bass enters at bar 2 and plays the root of each bar
   * on every beat, the root changing on "one" — E, A, G, D.
   */
  function song(lead: number) {
    const bpm = 120;
    const beat = 60 / bpm;
    const seconds = lead + 10 * 4 * beat;
    const band = rockBeat(seconds, bpm, lead);
    const bass = new Float32Array(Math.round(seconds * SR));
    const roots = [28, 33, 31, 38];
    for (let bar = 1; bar < 9; bar++) {
      for (let k = 0; k < 4; k++) pluck(bass, lead + (bar * 4 + k) * beat, beat, roots[(bar - 1) % 4]);
    }
    return { bass, band };
  }
  const notesPerBar = (alphaTex: string) =>
    alphaTex
      .split('\n')
      .filter((l) => l.endsWith('|'))
      .map((b) => [...b.matchAll(/\b(\d+)\.(\d)\b/g)].map((m) => `${m[1]}.${m[2]}`).join(' '));

  it('writes the line in the right bars, whatever silence comes first', () => {
    for (const lead of [0.05, 0.237, 0.9]) {
      const { bass, band } = song(lead);
      const tab = transcribeTab({ bass, band, sampleRate: SR, title: 'Song' });
      const bars = notesPerBar(tab.alphaTex);
      expect(tab.bpm).toBe(120);
      expect(tab.beatsPerBar).toBe(4);
      // Bar 1 is the band alone; the bass comes in on bar 2.
      expect(bars[0]).toBe('');
      expect(bars.slice(1, 5)).toEqual(['0.4 0.4 0.4 0.4', '0.3 0.3 0.3 0.3', '3.4 3.4 3.4 3.4', '0.2 0.2 0.2 0.2']);
      // Bar 2 is anchored where the bass comes in.
      const barTwo = tab.anchors.find((a) => a.barIndex === 1);
      expect(Math.abs((barTwo?.audioMs ?? 0) - (lead + 2) * 1000)).toBeLessThan(30);
    }
  });

  it('re-lays the same notes out without listening again', () => {
    const { bass, band } = song(0.237);
    const analysis = analyseTab({ bass, band, sampleRate: SR });
    const normal = writeTabFrom(analysis, { title: 'Song' });
    const later = writeTabFrom(analysis, { title: 'Song', downbeatPhase: normal.downbeatPhase + 1 });
    expect(later.notes).toHaveLength(normal.notes.length);
    // Every bar line moves one beat (500ms) later in the recording.
    const lines = (tab: typeof normal) => tab.anchors.map((a) => a.audioMs);
    const moved = lines(normal).map((ms) => ms + 500);
    for (const ms of lines(later)) expect(moved.some((m) => Math.abs(m - ms) < 30)).toBe(true);
    expect(writeTabFrom(analysis, { title: 'Song', beatsPerBar: 3 }).beatsPerBar).toBe(3);
  });

  it('finds the beat on the bass alone when the band stem is empty', () => {
    const { bass } = song(0.5);
    const analysis = analyseTab({ bass, band: new Float32Array(bass.length), sampleRate: SR });
    expect(analysis.beatSource).toBe('bass');
    expect(Math.round(analysis.bpm)).toBe(120);
  });
});

describe('decode', () => {
  it('averages channels to mono', () => {
    expect(Array.from(toMonoSamples([new Float32Array([1, 0.5]), new Float32Array([0, 0.5])]))).toEqual([0.5, 0.5]);
  });
});
