"""
Stand-in for yt-dlp, protocol testing only — same idea as the demucs and basic-pitch stubs.

Real yt-dlp needs the network and a live YouTube, neither of which a test can count on. This
answers the same Python API: it calls the progress hooks and the match filter the way yt-dlp
does, writes an audio file where `outtmpl` says, and returns an info dict in the real shape —
so the sidecar's /youtube route, the polling and the browser plumbing all get exercised.

The "audio" is a few seconds of A1 (55Hz) as WAV, which the demucs and basic-pitch stubs can
both read, so a whole link -> stem -> tab run works end to end.

Two video ids behave specially, to exercise the failure paths:
  LiveStream0  -> reported as a live stream (the sidecar's filter must refuse it)
  Unavailable  -> raises, the way yt-dlp does for a removed or private video
"""

from __future__ import annotations

import math
import re
import struct
import wave
from pathlib import Path

from .version import __version__  # noqa: F401


class DownloadError(Exception):
    pass


class YoutubeDL:
    def __init__(self, params: dict | None = None) -> None:
        self.params = params or {}

    def __enter__(self) -> "YoutubeDL":
        return self

    def __exit__(self, *exc) -> None:
        return None

    def extract_info(self, url: str, download: bool = True) -> dict:
        match = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", url)
        video_id = match.group(1) if match else "unknown0000"

        if video_id == "Unavailable":
            raise DownloadError(f"ERROR: [youtube] {video_id}: Video unavailable")

        seconds = 4
        info = {
            "id": video_id,
            "title": f"Stub Song {video_id}",
            "uploader": "Stub Channel",
            "duration": seconds,
            "is_live": video_id == "LiveStream0",
            "webpage_url": f"https://www.youtube.com/watch?v={video_id}",
        }

        match_filter = self.params.get("match_filter")
        if match_filter and match_filter(info, incomplete=False):
            # Real yt-dlp hands back the info dict with nothing downloaded.
            return info

        if not download:
            return info

        out = Path(self.params["outtmpl"].replace("%(ext)s", "wav"))
        hooks = self.params.get("progress_hooks", [])
        total = 44 + 44100 * seconds * 4
        for step in range(1, 5):
            for hook in hooks:
                hook({"status": "downloading", "downloaded_bytes": total * step // 4, "total_bytes": total})
        _write_tone(out, seconds)
        for hook in hooks:
            hook({"status": "finished", "filename": str(out)})

        info["requested_downloads"] = [{"filepath": str(out), "ext": "wav"}]
        return info


def _write_tone(path: Path, seconds: int, hz: float = 55.0) -> None:
    sr = 44100
    frames = bytearray()
    for i in range(sr * seconds):
        v = int(math.sin(2 * math.pi * hz * i / sr) * 8000)
        frames += struct.pack("<hh", v, v)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))
