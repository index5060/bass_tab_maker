/**
 * Turn an alphaTex score into audio, in Node, with alphaTab's own synthesizer.
 *
 * This is how the evaluation gets test recordings whose correct tab is known exactly: write
 * the tab, render it. The instruments are real recorded samples (the sonivox General MIDI
 * soundfont the app already ships), with a band around the bass — far closer to a song than
 * the pure tones the earlier tests used, though still not a real recording.
 *
 * Tracks can be rendered on their own, so one score gives the three files the app works
 * with: the bass stem, everything-but-the-bass, and the full mix.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as alphaTab from '@coderline/alphatab';

alphaTab.Logger.logLevel = alphaTab.LogLevel.Error;

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOUNDFONT = path.join(ROOT, 'node_modules', '@coderline', 'alphatab', 'dist', 'soundfont', 'sonivox.sf3');
export const SAMPLE_RATE = 44100;

export function parseTex(tex) {
  const settings = new alphaTab.Settings();
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, settings);
  return { score: importer.readScore(), settings };
}

/** A synth output that goes nowhere: the exporter renders offline and never plays. */
function silentOutput() {
  const event = () => ({ on() {}, off() {} });
  return {
    sampleRate: SAMPLE_RATE,
    ready: event(),
    samplesPlayed: event(),
    sampleRequest: event(),
    open() {},
    play() {},
    pause() {},
    destroy() {},
    addSamples() {},
    resetSamples() {},
    activate() {},
    enumerateOutputDevices: async () => [],
    setOutputDevice: async () => {},
    getOutputDevice: async () => null,
  };
}

/**
 * Render the score to mono samples.
 * @param {string} tex
 * @param {{ tracks?: string[], leadMs?: number }} options  `tracks`: names to keep audible
 *   (all when omitted). `leadMs`: silence before the music, as real files have.
 */
export function renderTex(tex, options = {}) {
  const { score, settings } = parseTex(tex);
  if (options.tracks) {
    for (const track of score.tracks) {
      if (!options.tracks.includes(track.name)) track.playbackInfo.volume = 0;
    }
  }
  const midi = new alphaTab.midi.MidiFile();
  new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(midi)).generate();

  const exportOptions = new alphaTab.synth.AudioExportOptions();
  exportOptions.soundFonts = [new Uint8Array(fs.readFileSync(SOUNDFONT))];
  exportOptions.sampleRate = SAMPLE_RATE;
  exportOptions.useSyncPoints = false;
  const exporter = new alphaTab.synth.AlphaSynth(silentOutput(), 500).exportAudio(exportOptions, midi, [], new Map());

  const chunks = [];
  for (;;) {
    const chunk = exporter.render(1000);
    if (!chunk) break;
    chunks.push(chunk.samples);
  }
  const interleaved = chunks.reduce((n, c) => n + c.length, 0);
  const lead = Math.round(((options.leadMs ?? 0) / 1000) * SAMPLE_RATE);
  const mono = new Float32Array(lead + interleaved / 2);
  let at = lead;
  for (const c of chunks) {
    for (let i = 0; i + 1 < c.length; i += 2) mono[at++] = (c[i] + c[i + 1]) / 2;
  }
  return mono;
}

export function mix(...signals) {
  const out = new Float32Array(Math.max(...signals.map((s) => s.length)));
  for (const s of signals) for (let i = 0; i < s.length; i++) out[i] += s[i];
  return out;
}

/** 16-bit PCM mono WAV — the plainest file every part of the app reads. */
export function writeWav(file, samples) {
  const data = Buffer.alloc(samples.length * 2);
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0.99 ? 0.99 / peak : 1;
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(samples[i] * gain * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24);
  head.writeUInt32LE(SAMPLE_RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, data]));
}
