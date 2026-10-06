import { describe, it, expect } from 'vitest';
import { parseYouTubeUrl } from './youtube';
import { fileSafe, needsWavForSidecar } from './sidecar';

const ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe('parseYouTubeUrl', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`http://youtube.com/watch?v=${ID}`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}&feature=share`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=AbCdEf123`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube.com/live/${ID}?feature=shared`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
  ])('accepts %s', (input) => {
    expect(parseYouTubeUrl(input)).toEqual({ videoId: ID, url: CANONICAL });
  });

  it('drops the playlist so only the one video is fetched', () => {
    // A list= left in would have yt-dlp pull the whole playlist.
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&index=3`)?.url).toBe(
      CANONICAL,
    );
  });

  it('drops the start time', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=42`)?.url).toBe(CANONICAL);
  });

  it('accepts a pasted link without a scheme, and stray whitespace', () => {
    expect(parseYouTubeUrl(`  youtu.be/${ID}\n`)?.videoId).toBe(ID);
    expect(parseYouTubeUrl(`www.youtube.com/watch?v=${ID}`)?.videoId).toBe(ID);
  });

  it.each([
    [''],
    ['노래 제목'],
    [ID], // a bare id is too ambiguous to guess at
    [`https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG`],
    [`https://www.youtube.com/@SomeChannel`],
    [`https://www.youtube.com/watch?v=short`],
    [`https://www.youtube.com/watch?v=${ID}x`],
    [`https://evil.example.com/watch?v=${ID}`],
    [`https://youtube.com.evil.example/watch?v=${ID}`],
    [`ftp://youtube.com/watch?v=${ID}`],
    [`javascript:alert(1)//youtube.com/watch?v=${ID}`],
  ])('rejects %s', (input) => {
    expect(parseYouTubeUrl(input)).toBeNull();
  });
});

describe('needsWavForSidecar', () => {
  const m4a = new File([new Uint8Array(4)], 'song.m4a', { type: 'audio/mp4' });
  const wav = new File([new Uint8Array(4)], 'song.wav', { type: 'audio/wav' });

  it('converts compressed audio only when the sidecar says it has no ffmpeg', () => {
    expect(needsWavForSidecar(m4a, false)).toBe(true);
    expect(needsWavForSidecar(m4a, true)).toBe(false);
  });

  it('never converts what is already WAV', () => {
    expect(needsWavForSidecar(wav, false)).toBe(false);
  });

  it('leaves an older sidecar that does not report ffmpeg alone', () => {
    // That is how it always behaved; converting would only cost time.
    expect(needsWavForSidecar(m4a, null)).toBe(false);
  });
});

describe('fileSafe', () => {
  it('keeps Korean titles and strips what Windows forbids', () => {
    expect(fileSafe('아이유 - 밤편지 (Live) | MV: "공식"?')).toBe('아이유 - 밤편지 (Live) _ MV_ _공식__');
  });

  it('caps the length', () => {
    expect(fileSafe('a'.repeat(300))).toHaveLength(80);
  });
});
