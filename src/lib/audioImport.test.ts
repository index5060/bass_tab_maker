import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prepareAudioFile, type PrepareDeps } from './audioImport';
import { decodeWav, readWavInfo } from './wav';

const FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'wav');
const fixture = (name: string, as = `${name}.wav`, type = 'audio/wav') =>
  new File([fs.readFileSync(path.join(FIXTURES, `${name}.wav`))], as, { type });

const noBrowser: PrepareDeps = {
  decodeWithBrowser: async () => {
    throw new Error('not available in this test');
  },
};

async function infoOf(file: File) {
  return readWavInfo(await file.arrayBuffer());
}

describe('prepareAudioFile', () => {
  it('keeps a plain 16-bit PCM WAV byte for byte', async () => {
    const picked = fixture('pcm16');
    const { file, note } = await prepareAudioFile(picked, noBrowser);
    expect(note).toBeNull();
    expect(file).toBe(picked);
  });

  it('keeps 24-bit PCM too, even in the extensible header ffmpeg and DAWs write', async () => {
    const picked = fixture('pcm24');
    const { file, note } = await prepareAudioFile(picked, noBrowser);
    expect(note).toBeNull();
    expect(file).toBe(picked);
  });

  it.each([
    ['float64', 'float 64비트'],
    ['ima_adpcm', 'IMA ADPCM'],
    ['ms_adpcm', 'MS ADPCM'],
    ['float32', 'float 32비트'],
    ['pcm8', 'PCM 8비트'],
    ['mulaw', 'µ-law'],
    ['rf64', 'PCM 16비트'],
  ])('converts %s to 16-bit PCM that every browser plays', async (name, formatName) => {
    const { file, note } = await prepareAudioFile(fixture(name), noBrowser);
    expect(note).toContain(formatName);
    expect(file.name).toBe(`${name}.wav`);
    expect(file.type).toBe('audio/wav');
    const info = await infoOf(file);
    expect([info.container, info.formatCode, info.bitsPerSample, info.channels]).toEqual(['RIFF', 1, 16, 2]);
    // Same sound, same length, same rate.
    const before = decodeWav(await fixture(name).arrayBuffer());
    const after = decodeWav(await file.arrayBuffer());
    expect(after.sampleRate).toBe(before.sampleRate);
    expect(after.channels[0].length).toBe(before.channels[0].length);
    let worst = 0;
    for (let i = 0; i < before.channels[0].length; i++) {
      worst = Math.max(worst, Math.abs(after.channels[0][i] - before.channels[0][i]));
    }
    expect(worst).toBeLessThan(1 / 16384);
  });

  it('folds surround down to stereo and says how many channels it had', async () => {
    const { file, note } = await prepareAudioFile(fixture('surround51'), noBrowser);
    expect(note).toContain('6채널');
    expect((await infoOf(file)).channels).toBe(2);
  });

  it('recognises a WAV by its content, whatever it is called', async () => {
    // Uppercase extension and an empty type, the way Windows sometimes hands files over.
    const upper = await prepareAudioFile(fixture('pcm16', 'TAKE 1.WAV', ''), noBrowser);
    expect(upper.file.type).toBe('audio/wav');
    expect(upper.file.name).toBe('TAKE 1.WAV');
    // A WAV saved with the wrong extension still gets read as the WAV it is.
    const misnamed = await prepareAudioFile(fixture('float64', 'take.mp3', 'audio/mpeg'), noBrowser);
    expect(misnamed.file.name).toBe('take.wav');
    expect((await infoOf(misnamed.file)).formatCode).toBe(1);
  });

  it('passes anything that is not a WAV through untouched', async () => {
    const mp3 = new File([new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3])], 'song.mp3', {
      type: 'audio/mpeg',
    });
    const { file, note } = await prepareAudioFile(mp3, noBrowser);
    expect(file).toBe(mp3);
    expect(note).toBeNull();
  });

  /** A WAV in a format wav.ts does not decode (MP3 inside a WAV header). */
  function mp3InWav(): File {
    const pcm = fs.readFileSync(path.join(FIXTURES, 'pcm16.wav'));
    const bytes = new Uint8Array(pcm);
    const view = new DataView(bytes.buffer);
    // Find the fmt chunk and change its format code to 0x0055 (MPEG Layer 3).
    for (let i = 12; i < bytes.length - 8; i++) {
      if (String.fromCharCode(...bytes.slice(i, i + 4)) === 'fmt ') {
        view.setUint16(i + 8, 0x0055, true);
        break;
      }
    }
    return new File([bytes], 'odd.wav', { type: 'audio/wav' });
  }

  it('asks the browser for formats it does not read itself, and converts what comes back', async () => {
    const viaBrowser: PrepareDeps = {
      decodeWithBrowser: async () => ({ sampleRate: 8000, channels: [new Float32Array(800).fill(0.25)] }),
    };
    const { file, note } = await prepareAudioFile(mp3InWav(), viaBrowser);
    expect(note).toContain('MP3');
    expect((await infoOf(file)).formatCode).toBe(1);
  });

  it('says what the format is and what to do when nothing can read it', async () => {
    await expect(prepareAudioFile(mp3InWav(), noBrowser)).rejects.toThrow(/MP3 형식.*PCM 16비트 또는 24비트/);
  });
});
