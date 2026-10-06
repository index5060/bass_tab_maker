"""
`python -m demucs` stand-in.

Accepts the same flags the sidecar passes, emits tqdm-shaped progress so the percentage
parser has something realistic to chew on, and writes bass.wav / no_bass.wav into the layout
real demucs uses: <out>/<model>/<track name>/.

The "separation" is a trivial split — the point is the plumbing, not the audio.
"""

from __future__ import annotations

import argparse
import struct
import sys
import time
import wave
from pathlib import Path


def read_wav(path: Path):
    with wave.open(str(path), "rb") as w:
        return w.getparams(), w.readframes(w.getnframes())


def write_wav(path: Path, params, frames: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setparams(params)
        w.writeframes(frames)


def scale_frames(frames: bytes, factor: float) -> bytes:
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    scaled = [max(-32768, min(32767, int(s * factor))) for s in samples]
    return struct.pack(f"<{len(scaled)}h", *scaled)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-n", "--name", default="htdemucs")
    parser.add_argument("--two-stems", default=None)
    parser.add_argument("--shifts", type=int, default=1)
    parser.add_argument("--overlap", type=float, default=0.25)
    parser.add_argument("-o", "--out", required=True)
    parser.add_argument("tracks", nargs="+")
    args = parser.parse_args()

    track = Path(args.tracks[0])
    print(f"Selected model is a bag of 1 models. (stub {args.name})", file=sys.stderr)
    print(f"Separated tracks will be stored in {args.out}", file=sys.stderr)

    for pct in range(0, 101, 20):
        bar = "█" * (pct // 10)
        print(f" {pct}%|{bar:<10}| {pct}/100 [00:00<00:00]", file=sys.stderr)
        sys.stderr.flush()
        time.sleep(0.05)

    try:
        params, frames = read_wav(track)
    except Exception as exc:  # noqa: BLE001
        print(f"stub could not read {track}: {exc}", file=sys.stderr)
        return 1

    dest = Path(args.out) / args.name / track.stem
    # A crude split so the two files differ and sum back to roughly the input.
    write_wav(dest / "bass.wav", params, scale_frames(frames, 0.6))
    write_wav(dest / "no_bass.wav", params, scale_frames(frames, 0.4))

    print(f"stub wrote {dest}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
