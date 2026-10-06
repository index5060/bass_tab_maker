/**
 * Recognise a YouTube link and reduce it to the one video it names.
 *
 * People paste whatever their address bar or share sheet gave them: a youtu.be short link, a
 * Shorts URL, a music.youtube.com link, or a watch URL dragging `list=`, `t=` and `si=` along
 * behind it. All of those name one video, and one video is what we want — a `list=` left in
 * would have yt-dlp pull a whole playlist.
 *
 * The sidecar applies the same rules again before it touches anything (it must not trust the
 * page), so this exists to answer "is that a link?" instantly, before a round trip.
 */

const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubeLink {
  videoId: string;
  /** The canonical single-video URL, with every extra parameter dropped. */
  url: string;
}

export function parseYouTubeUrl(text: string): YouTubeLink | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    // A pasted "youtu.be/abc…" without a scheme is still unmistakably a link.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  let videoId: string | null = null;
  if (parsed.hostname.toLowerCase() === 'youtu.be') {
    videoId = parts[0] ?? null;
  } else if (parts[0] === 'watch') {
    videoId = parsed.searchParams.get('v');
  } else if (parts.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
    videoId = parts[1];
  }

  if (!videoId || !VIDEO_ID.test(videoId)) return null;
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}
