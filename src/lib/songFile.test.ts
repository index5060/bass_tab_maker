import { describe, it, expect } from 'vitest';
import { encodeSongFile, decodeSongFile, songFileName, SONG_FILE_EXTENSION } from './songFile';
import { newPracticeDoc, type PracticeDoc } from './types';

// Built on an explicit ArrayBuffer so the view's buffer type is ArrayBuffer rather than
// ArrayBufferLike, which BlobPart and PracticeDoc.scoreData both insist on.
function bytes(n: number, seed = 7): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(n);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < n; i++) out[i] = (i * seed + 13) % 256;
  return out;
}

function fullDoc(): PracticeDoc {
  return newPracticeDoc({
    id: 'song-1',
    title: 'Test Song',
    artist: 'Nobody',
    scoreKind: 'gp',
    scoreData: bytes(300, 3).buffer,
    scoreFileName: 'test.gp5',
    audioBlob: new Blob([bytes(1024, 5)], { type: 'audio/mpeg' }),
    audioFileName: 'test.mp3',
    stems: {
      bass: new Blob([bytes(2048, 11)], { type: 'audio/wav' }),
      minusBass: new Blob([bytes(4096, 17)], { type: 'audio/wav' }),
      sampleRate: 44100,
      durationMs: 12345,
      model: 'htdemucs (browser)',
      createdAt: 1700000000000,
    },
    syncAnchors: [
      { synthTick: 0, audioMs: 250, barIndex: 0, barOccurence: 0 },
      { synthTick: 3840, audioMs: 2250, barIndex: 1, barOccurence: 0 },
    ],
    bookmarks: [{ id: 'b1', tick: 960, barIndex: 0, note: '여기 항상 틀림' }],
    lastSpeed: 0.8,
    lastSource: 'bass',
    trackIndex: 2,
  });
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

describe('song file round trip', () => {
  it('preserves scalar metadata', async () => {
    const original = fullDoc();
    const restored = await decodeSongFile(await encodeSongFile(original));

    expect(restored.id).toBe(original.id);
    expect(restored.title).toBe(original.title);
    expect(restored.artist).toBe(original.artist);
    expect(restored.scoreKind).toBe('gp');
    expect(restored.scoreFileName).toBe('test.gp5');
    expect(restored.audioFileName).toBe('test.mp3');
    expect(restored.lastSpeed).toBe(0.8);
    expect(restored.lastSource).toBe('bass');
    expect(restored.trackIndex).toBe(2);
  });

  it('preserves the practice sidecar', async () => {
    const original = fullDoc();
    const restored = await decodeSongFile(await encodeSongFile(original));

    expect(restored.syncAnchors).toEqual(original.syncAnchors);
    expect(restored.bookmarks).toEqual(original.bookmarks);
  });

  it('preserves the score bytes exactly', async () => {
    const original = fullDoc();
    const restored = await decodeSongFile(await encodeSongFile(original));

    expect(new Uint8Array(restored.scoreData as ArrayBuffer)).toEqual(
      new Uint8Array(original.scoreData as ArrayBuffer),
    );
  });

  it('preserves audio and both stems byte for byte', async () => {
    const original = fullDoc();
    const restored = await decodeSongFile(await encodeSongFile(original));

    expect(await blobBytes(restored.audioBlob!)).toEqual(await blobBytes(original.audioBlob!));
    expect(await blobBytes(restored.stems!.bass)).toEqual(await blobBytes(original.stems!.bass));
    expect(await blobBytes(restored.stems!.minusBass)).toEqual(
      await blobBytes(original.stems!.minusBass),
    );
  });

  it('keeps the stem metadata alongside the blobs', async () => {
    const original = fullDoc();
    const restored = await decodeSongFile(await encodeSongFile(original));

    expect(restored.stems!.sampleRate).toBe(44100);
    expect(restored.stems!.durationMs).toBe(12345);
    expect(restored.stems!.model).toBe('htdemucs (browser)');
  });

  it('handles an alphaTex song with no audio at all', async () => {
    const doc = newPracticeDoc({ id: 'tex-1', scoreKind: 'alphatex', scoreData: '\\title "x"\n.' });
    const restored = await decodeSongFile(await encodeSongFile(doc));

    expect(restored.scoreKind).toBe('alphatex');
    expect(restored.scoreData).toBe('\\title "x"\n.');
    expect(restored.audioBlob).toBeUndefined();
    expect(restored.stems).toBeUndefined();
  });

  it('does not inflate the payload the way base64 would', async () => {
    const doc = fullDoc();
    const file = await encodeSongFile(doc);
    const payload = 300 + 1024 + 2048 + 4096;
    // Header is small JSON; base64 would have cost ~33% on top of the payload.
    expect(file.size).toBeGreaterThanOrEqual(payload);
    expect(file.size).toBeLessThan(payload * 1.2);
  });
});

describe('song file rejects bad input', () => {
  it('rejects a file that is too short', async () => {
    await expect(decodeSongFile(new Blob([new Uint8Array(4)]))).rejects.toThrow(/짧습니다/);
  });

  it('rejects a file without the magic', async () => {
    await expect(decodeSongFile(new Blob([bytes(200)]))).rejects.toThrow(/백업 파일이 아닙니다/);
  });

  it('rejects a corrupted header', async () => {
    const good = await encodeSongFile(fullDoc());
    const raw = new Uint8Array(await good.arrayBuffer());
    raw[12] = 0x00; // scribble inside the JSON header
    raw[13] = 0x00;
    await expect(decodeSongFile(new Blob([raw]))).rejects.toThrow(/손상|헤더/);
  });
});

describe('songFileName', () => {
  it('uses the title and the extension', () => {
    expect(songFileName(newPracticeDoc({ title: 'My Song' }))).toBe(`My Song${SONG_FILE_EXTENSION}`);
  });

  it('strips characters Windows will not accept', () => {
    const name = songFileName(newPracticeDoc({ title: 'a/b:c*d?e"f<g>h|i' }));
    expect(name).toBe(`a_b_c_d_e_f_g_h_i${SONG_FILE_EXTENSION}`);
  });

  it('falls back when the title is empty', () => {
    expect(songFileName(newPracticeDoc({ title: '' }))).toBe(`song${SONG_FILE_EXTENSION}`);
  });
});
