#!/usr/bin/env python3
"""
Local separation sidecar for Bass Practice.

Why this exists
---------------
The browser separator runs a fixed, quantised HTDemucs and exposes no knobs: no model
choice, no shift averaging, no overlap control, and no GPU. Those are exactly the settings
that decide whether a bass stem comes out clean or choppy. Rewriting the app as a desktop
program would unlock them, but it would also throw away everything already working in the
browser.

A sidecar keeps the web app exactly as it is and puts the heavy, configurable work in a
small local process next to it. The page talks to it over HTTP on localhost; if it is not
running, the app silently falls back to browser separation.

Dependencies: the Python standard library, plus whichever of these you want switched on.
Each one is optional and independent; the app falls back for any that are missing.

    pip install demucs                  # separation
    pip install basic-pitch             # AI transcription
    pip install -U "yt-dlp[default]"    # YouTube link -> audio
    python sidecar/server.py

Everything stays on this machine. The server binds to 127.0.0.1 and refuses to listen on
anything else.
"""

from __future__ import annotations

import sys as _sys

if _sys.version_info < (3, 8):
    # The `from __future__ import annotations` above keeps every annotation a string, so this
    # file parses on old interpreters and can print something useful instead of a SyntaxError
    # pointing at a line that is not really the problem.
    raise SystemExit(
        f"Python 3.8 이상이 필요합니다 (지금: {_sys.version.split()[0]}). "
        "python.org에서 최신 버전을 설치하세요."
    )

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("BASS_SIDECAR_PORT", "8765"))
# Only ever localhost. This process shells out to a subprocess and writes files; it has no
# business being reachable from the network.
HOST = "127.0.0.1"

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
JOB_RETENTION_SECONDS = 60 * 60

KNOWN_MODELS = ["htdemucs", "htdemucs_ft", "htdemucs_6s", "mdx_extra", "mdx_extra_q"]

# The only hosts /youtube will hand to yt-dlp. yt-dlp has a generic extractor that will fetch
# almost any URL it is given, and this process is reachable from every page the browser has
# open — so without an allowlist it would be a local fetch-anything proxy.
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtube-nocookie.com",
}
# Long enough for any song, short enough to refuse an hour-long mix or a stream by accident.
MAX_YOUTUBE_SECONDS = 30 * 60

AUDIO_CONTENT_TYPES = {
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "webm": "audio/webm",
    "opus": "audio/ogg",
    "ogg": "audio/ogg",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "flac": "audio/flac",
}


# --------------------------------------------------------------------------- jobs


@dataclass
class Job:
    id: str
    state: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    message: str = ""
    error: str | None = None
    workdir: Path | None = None
    bass_path: Path | None = None
    no_bass_path: Path | None = None
    created_at: float = field(default_factory=time.time)
    log_tail: list[str] = field(default_factory=list)
    # Transcription jobs put their result here instead of writing stem files.
    notes: list | None = None
    # YouTube jobs: the downloaded audio file and what the video says about itself.
    audio_path: Path | None = None
    meta: dict | None = None


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()


def cleanup_old_jobs() -> None:
    now = time.time()
    with JOBS_LOCK:
        stale = [j for j in JOBS.values() if now - j.created_at > JOB_RETENTION_SECONDS]
        for job in stale:
            if job.workdir and job.workdir.exists():
                shutil.rmtree(job.workdir, ignore_errors=True)
            JOBS.pop(job.id, None)


# ---------------------------------------------------------------------- demucs


def demucs_version() -> str | None:
    try:
        import demucs  # noqa: F401

        return getattr(demucs, "__version__", "unknown")
    except Exception:
        return None


def basic_pitch_version() -> str | None:
    """
    Spotify's basic-pitch, used for AI transcription of the separated bass stem.

    This replaces the hand-rolled YIN pipeline as the primary transcriber when available:
    a trained onset+pitch network is simply a different class of accuracy from classical
    autocorrelation, and it is the same family of tech behind "AI draft" features on tab
    sites. Optional — the browser falls back to the built-in detector without it.
    """
    try:
        import basic_pitch  # noqa: F401

        return getattr(basic_pitch, "__version__", "unknown")
    except Exception:
        return None


def ytdlp_version() -> str | None:
    """yt-dlp, which turns a YouTube link into an audio file. Optional like everything else."""
    try:
        from yt_dlp.version import __version__

        return __version__
    except Exception:
        return None


def ytdlp_has_ejs() -> bool:
    """
    Whether yt-dlp's YouTube challenge solver is installed.

    YouTube now scrambles its stream URLs with JavaScript, and yt-dlp only unscrambles them
    with the separate yt-dlp-ejs package plus a JS runtime. A bare `pip install yt-dlp` lacks
    the package and fails on most videos with a signature error that never says what to
    install. Reporting it up front turns that into one line in the UI.
    """
    try:
        import yt_dlp_ejs  # noqa: F401

        return True
    except Exception:
        return False


def ffmpeg_available() -> bool:
    """
    demucs reads anything but WAV through ffmpeg. Without it the app converts to WAV in the
    browser before sending, which is why the browser needs to know.
    """
    return shutil.which("ffmpeg") is not None


def torch_device() -> str:
    """Report the device demucs will actually use, since it decides minutes vs. tens of them."""
    try:
        import torch

        if torch.cuda.is_available():
            return f"cuda ({torch.cuda.get_device_name(0)})"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    except Exception:
        return "unknown"


# demucs writes a tqdm bar to stderr; this pulls the percentage back out of it.
PROGRESS_RE = re.compile(r"(\d+)%\|")


def run_separation(job: Job, audio_path: Path, model: str, shifts: int, overlap: float) -> None:
    out_dir = job.workdir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        "-m",
        "demucs",
        "-n",
        model,
        "--two-stems",
        "bass",  # bass + no_bass is all the app needs, and it is quicker than four stems
        "--shifts",
        str(shifts),
        "--overlap",
        str(overlap),
        "-o",
        str(out_dir),
        str(audio_path),
    ]

    job.state = "running"
    job.message = f"{model} 실행 중"

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True,
        )
    except FileNotFoundError:
        job.state = "error"
        job.error = "demucs를 실행하지 못했습니다. 'pip install demucs'를 먼저 하세요."
        return

    assert process.stdout is not None
    for line in process.stdout:
        line = line.rstrip()
        if line:
            job.log_tail.append(line)
            del job.log_tail[:-20]
        match = PROGRESS_RE.search(line)
        if match:
            job.progress = min(0.99, int(match.group(1)) / 100)

    code = process.wait()
    if code != 0:
        job.state = "error"
        job.error = f"demucs가 코드 {code}로 종료했습니다."
        job.message = "\n".join(job.log_tail[-5:])
        return

    # demucs writes to <out>/<model>/<track name>/{bass,no_bass}.wav
    produced = list(out_dir.rglob("bass.wav"))
    if not produced:
        job.state = "error"
        job.error = "demucs가 bass.wav를 만들지 않았습니다."
        job.message = "\n".join(job.log_tail[-5:])
        return

    job.bass_path = produced[0]
    no_bass = produced[0].parent / "no_bass.wav"
    job.no_bass_path = no_bass if no_bass.exists() else None
    job.progress = 1.0
    job.state = "done"
    job.message = "완료"


def run_transcription(job: Job, audio_path: Path) -> None:
    """
    Audio in, note events out, via basic-pitch.

    The frequency window is pinned to the bass register (30-500Hz): the input is an
    already-separated bass stem, so anything the model hears outside that range is bleed or
    a harmonic, and filtering here is cheaper and cleaner than filtering after the fact.
    """
    job.state = "running"
    job.message = "basic-pitch 실행 중"

    try:
        from basic_pitch.inference import predict
    except Exception:
        job.state = "error"
        job.error = "basic-pitch가 설치되어 있지 않습니다. 'pip install basic-pitch'."
        return

    try:
        try:
            _, _, note_events = predict(
                str(audio_path), minimum_frequency=30.0, maximum_frequency=500.0
            )
        except TypeError:
            # Older releases lack the frequency-window keywords.
            _, _, note_events = predict(str(audio_path))
    except Exception as exc:  # noqa: BLE001
        job.state = "error"
        job.error = f"basic-pitch 실패: {exc}"
        return

    notes = []
    for event in note_events:
        # (start_s, end_s, midi_pitch, amplitude, pitch_bends)
        start_s, end_s, pitch, amplitude = event[0], event[1], event[2], event[3]
        notes.append(
            {
                "startMs": round(float(start_s) * 1000),
                "endMs": round(float(end_s) * 1000),
                "midi": int(pitch),
                "confidence": round(float(amplitude), 3),
            }
        )
    notes.sort(key=lambda n: n["startMs"])

    job.notes = notes
    job.progress = 1.0
    job.state = "done"
    job.message = "완료"


# --------------------------------------------------------------------- youtube


def canonical_youtube_url(raw: str) -> str | None:
    """
    The one URL shape /youtube accepts, or None.

    Anything not on a YouTube host is refused outright (see YOUTUBE_HOSTS). Of what is left,
    only the video id is kept: a `list=` parameter would otherwise pull a whole playlist, and
    `t=`, `si=` and friends mean nothing to a download.
    """
    try:
        parsed = urlparse(raw.strip())
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or (parsed.hostname or "") not in YOUTUBE_HOSTS:
        return None

    host = parsed.hostname
    parts = [p for p in parsed.path.split("/") if p]
    video_id = None
    if host == "youtu.be":
        video_id = parts[0] if parts else None
    elif parts[:1] == ["watch"]:
        video_id = (parse_qs(parsed.query).get("v") or [None])[0]
    elif len(parts) >= 2 and parts[0] in ("shorts", "embed", "live", "v"):
        video_id = parts[1]

    if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return None
    return f"https://www.youtube.com/watch?v={video_id}"


class _YtdlpLog:
    """Collects yt-dlp's warnings so a failure can say why, instead of just 'it failed'."""

    def __init__(self, job: Job) -> None:
        self.job = job

    def _keep(self, msg: str) -> None:
        self.job.log_tail.append(msg)
        del self.job.log_tail[:-20]

    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        self._keep(msg)

    def error(self, msg: str) -> None:
        self._keep(msg)


def run_youtube_download(job: Job, url: str) -> None:
    """
    Link in, audio file out, via yt-dlp.

    Asks for the m4a (AAC) audio stream when there is one: every browser plays and decodes it,
    so the file can go straight into <audio> and decodeAudioData, and it is a few MB rather
    than the ~40MB a WAV of the same song would cost in IndexedDB. No re-encode either way.
    """
    job.state = "running"
    job.message = "YouTube 정보 읽는 중"

    try:
        import yt_dlp
    except Exception:
        job.state = "error"
        job.error = "yt-dlp가 설치되어 있지 않습니다. 'pip install -U \"yt-dlp[default]\"'."
        return

    def on_progress(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total:
                job.progress = min(0.95, done / total)
            job.message = f"다운로드 중 {done / 1024 / 1024:.1f}MB"
        elif d.get("status") == "finished":
            job.progress = 0.97
            job.message = "마무리 중"

    # A rejected video comes back from extract_info as an ordinary info dict with nothing
    # downloaded, so the reason has to be kept here to be reported at all.
    rejected: list[str] = []

    def refuse_long_or_live(info: dict, *, incomplete: bool = False) -> str | None:
        reason = None
        if info.get("is_live"):
            reason = "라이브 방송은 받을 수 없습니다."
        duration = info.get("duration")
        if duration and duration > MAX_YOUTUBE_SECONDS:
            reason = f"{int(duration // 60)}분짜리 영상입니다. {MAX_YOUTUBE_SECONDS // 60}분 이하만 받습니다."
        if reason:
            rejected.append(reason)
        return reason

    # yt-dlp needs a JS runtime to solve YouTube's stream challenges and only enables deno by
    # default. Node is the one runtime every user of this app is guaranteed to have, so offer
    # it too — the launcher passes the exact binary it is running on.
    js_runtimes: dict = {"deno": {}, "node": {}}
    node_path = os.environ.get("BASS_SIDECAR_NODE")
    if node_path:
        js_runtimes["node"] = {"path": node_path}

    options = {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": str(job.workdir / "audio.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "logger": _YtdlpLog(job),
        "progress_hooks": [on_progress],
        "match_filter": refuse_long_or_live,
        "max_filesize": MAX_UPLOAD_BYTES,
        "js_runtimes": js_runtimes,
    }

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as exc:  # noqa: BLE001
        job.state = "error"
        # yt-dlp prefixes its own errors with "ERROR: " and colour codes, and appends a "please
        # report this issue" footer; none of that helps here.
        detail = re.sub(r"\x1b\[[0-9;]*m", "", str(exc)).replace("ERROR: ", "")
        detail = detail.split("; please report")[0].strip()
        job.error = f"YouTube에서 받지 못했습니다: {detail}"
        job.message = "\n".join(job.log_tail[-3:])
        return

    if rejected or info is None:
        job.state = "error"
        job.error = rejected[-1] if rejected else "영상 정보를 읽지 못했습니다."
        return

    downloads = info.get("requested_downloads") or []
    produced = [Path(d["filepath"]) for d in downloads if d.get("filepath")]
    produced += sorted(job.workdir.glob("audio.*"))
    produced = [p for p in produced if p.exists() and p.suffix not in (".part", ".ytdl")]
    if not produced:
        job.state = "error"
        job.error = "yt-dlp가 오디오 파일을 만들지 않았습니다."
        job.message = "\n".join(job.log_tail[-3:])
        return

    job.audio_path = produced[0]
    ext = job.audio_path.suffix.lstrip(".").lower()
    job.meta = {
        "title": info.get("track") or info.get("title") or "YouTube",
        "artist": info.get("artist") or info.get("uploader") or info.get("channel") or "",
        "durationSec": info.get("duration"),
        "videoId": info.get("id"),
        "url": info.get("webpage_url") or url,
        "ext": ext,
        "contentType": AUDIO_CONTENT_TYPES.get(ext, "application/octet-stream"),
        "bytes": job.audio_path.stat().st_size,
    }
    job.progress = 1.0
    job.state = "done"
    job.message = "완료"


# ------------------------------------------------------------------- http layer


class Handler(BaseHTTPRequestHandler):
    server_version = "BassPracticeSidecar/1.0"

    def log_message(self, fmt: str, *args) -> None:  # quieter console
        sys.stderr.write("  %s\n" % (fmt % args))

    # -- helpers ----------------------------------------------------------

    def _cors(self) -> None:
        """
        The app page is cross-origin isolated (COOP/COEP), which it needs for the browser
        separator's SharedArrayBuffer. That makes every response from this different origin
        subject to CORP as well as CORS, so both headers have to be here or the fetch fails
        with an opaque network error that says nothing useful.
        """
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, content_type: str = "audio/wav") -> None:
        data = path.read_bytes()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _origin_allowed(self) -> bool:
        """
        Only the app, served from this machine, may start work here.

        Binding to 127.0.0.1 keeps the network out, but not other web pages: any site open in
        the browser can POST to localhost. Browsers always attach Origin to such a request, so
        refusing foreign origins stops a random page from making this process download videos
        or spin the GPU. No Origin at all means a non-browser caller (curl, tests) — allowed.
        """
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        try:
            host = urlparse(origin).hostname or ""
        except ValueError:
            return False
        return host in ("localhost", "127.0.0.1", "::1")

    # -- routes -----------------------------------------------------------

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _status_page(self) -> None:
        """
        A human-readable page at "/".

        Checking a local server by pasting its URL into a browser is the obvious thing to do,
        and answering that with a bare {"error": "not found"} makes a perfectly healthy
        sidecar look broken. This says what is running and where to actually go.
        """
        version = demucs_version()
        device = torch_device()
        ready = version is not None
        slow = ready and device.startswith("cpu")

        ytdlp = ytdlp_version()
        rows = "".join(
            f"<tr><th>{k}</th><td>{v}</td></tr>"
            for k, v in [
                ("상태", "준비됨" if ready else "demucs 없음"),
                ("demucs (분리)", version or "설치되지 않음"),
                ("basic-pitch (AI 채보)", basic_pitch_version() or "설치되지 않음"),
                ("yt-dlp (YouTube)", ytdlp or "설치되지 않음"),
                ("ffmpeg", "있음" if ffmpeg_available() else "없음"),
                ("장치", device),
                ("포트", str(PORT)),
            ]
        )
        note = (
            "<p class='warn'>demucs가 없습니다. <code>py -m pip install demucs</code> 후 "
            "이 서버를 다시 실행하세요.</p>"
            if not ready
            else (
                "<p class='warn'>GPU가 아니라 CPU로 돌아갑니다. 4분짜리 곡이 수십 분 걸릴 수 "
                "있으니 shifts는 0~1로 두고 시작하세요.</p>"
                if slow
                else ""
            )
        )

        html = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>Bass Practice 사이드카</title>
<style>
 body{{background:#0f1115;color:#e6e9ef;font:14px/1.7 system-ui,'Malgun Gothic',sans-serif;
      margin:0;padding:48px 24px;display:flex;justify-content:center}}
 main{{max-width:520px;width:100%}}
 h1{{font-size:19px;margin:0 0 4px}}
 .sub{{color:#8b94a5;margin:0 0 24px}}
 table{{width:100%;border-collapse:collapse;background:#161a21;border-radius:10px;
        overflow:hidden;margin-bottom:20px}}
 th,td{{text-align:left;padding:9px 14px;border-bottom:1px solid #2a303b}}
 tr:last-child th,tr:last-child td{{border-bottom:none}}
 th{{color:#8b94a5;font-weight:400;width:38%}}
 td{{font-family:ui-monospace,Consolas,monospace}}
 code{{background:#161a21;border-radius:4px;padding:1px 6px}}
 .warn{{color:#f0a04b}}
 a{{color:#6ea8fe}}
</style></head><body><main>
<h1>Bass Practice 사이드카</h1>
<p class="sub">이 주소는 앱이 호출하는 API입니다. 여기서 연습하는 게 아닙니다.</p>
<table><tbody>{rows}</tbody></table>
{note}
<p>연습은 앱에서 하세요 — 보통 <a href="http://localhost:5173">http://localhost:5173</a>입니다.
스템 분리 패널에 <strong>로컬 사이드카 사용</strong> 상자가 보이면 연결된 겁니다.</p>
<p class="sub">이 창은 닫으셔도 됩니다. 서버는 터미널에서 Ctrl+C로 끕니다.</p>
</main></body></html>"""

        body = html.encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]

        if not parts:
            self._status_page()
            return

        if parts == ["favicon.ico"]:
            self.send_response(204)
            self.end_headers()
            return

        if parts == ["health"]:
            version = demucs_version()
            self._json(
                {
                    "ok": True,
                    "name": "bass-practice-sidecar",
                    "version": 1,
                    "demucs": version,
                    "demucsInstalled": version is not None,
                    "basicPitch": basic_pitch_version(),
                    "ytdlp": ytdlp_version(),
                    "ytdlpEjs": ytdlp_has_ejs(),
                    "ffmpeg": ffmpeg_available(),
                    "device": torch_device(),
                    "models": KNOWN_MODELS,
                }
            )
            return

        if len(parts) >= 2 and parts[0] == "jobs":
            with JOBS_LOCK:
                job = JOBS.get(parts[1])
            if job is None:
                self._json({"error": "그런 작업이 없습니다."}, 404)
                return

            if len(parts) == 2:
                self._json(
                    {
                        "id": job.id,
                        "state": job.state,
                        "progress": job.progress,
                        "message": job.message,
                        "error": job.error,
                        "hasNoBass": job.no_bass_path is not None,
                        "meta": job.meta,
                    }
                )
                return

            if len(parts) == 3 and parts[2] == "audio":
                if job.state != "done" or job.audio_path is None:
                    self._json({"error": "아직 준비되지 않았습니다."}, 409)
                    return
                self._file(job.audio_path, (job.meta or {}).get("contentType", "application/octet-stream"))
                return

            if len(parts) == 3 and parts[2] == "notes":
                if job.state != "done" or job.notes is None:
                    self._json({"error": "아직 준비되지 않았습니다."}, 409)
                    return
                self._json({"notes": job.notes})
                return

            if len(parts) == 3 and parts[2] in ("bass", "no_bass"):
                path = job.bass_path if parts[2] == "bass" else job.no_bass_path
                if job.state != "done" or path is None:
                    self._json({"error": "아직 준비되지 않았습니다."}, 409)
                    return
                self._file(path)
                return

        self._json({"error": "not found"}, 404)

    def _start_youtube(self) -> None:
        if ytdlp_version() is None:
            self._json(
                {"error": "yt-dlp가 설치되어 있지 않습니다. 'pip install -U \"yt-dlp[default]\"'."},
                503,
            )
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 8192:
            self._json({"error": "요청 본문이 없거나 너무 깁니다."}, 400)
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json({"error": "JSON 본문이 올바르지 않습니다."}, 400)
            return

        url = canonical_youtube_url(str(body.get("url", ""))) if isinstance(body, dict) else None
        if url is None:
            self._json({"error": "YouTube 영상 링크가 아닙니다."}, 400)
            return

        cleanup_old_jobs()
        job = Job(id=uuid.uuid4().hex)
        job.workdir = Path(tempfile.mkdtemp(prefix="bassprac-yt-"))
        with JOBS_LOCK:
            JOBS[job.id] = job
        threading.Thread(target=run_youtube_download, args=(job, url), daemon=True).start()
        self._json({"id": job.id, "url": url})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        route = [p for p in parsed.path.split("/") if p]
        if route not in (["separate"], ["transcribe"], ["youtube"]):
            self._json({"error": "not found"}, 404)
            return
        if not self._origin_allowed():
            self._json({"error": "사이드카는 localhost 주소로 연 앱에서만 쓸 수 있습니다."}, 403)
            return
        if route == ["youtube"]:
            self._start_youtube()
            return
        transcribing = route == ["transcribe"]

        if transcribing:
            if basic_pitch_version() is None:
                self._json(
                    {"error": "basic-pitch가 설치되어 있지 않습니다. 'pip install basic-pitch'."},
                    503,
                )
                return
        elif demucs_version() is None:
            self._json({"error": "demucs가 설치되어 있지 않습니다. 'pip install demucs'."}, 503)
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            self._json({"error": "오디오 데이터가 없습니다."}, 400)
            return
        if length > MAX_UPLOAD_BYTES:
            self._json({"error": "파일이 너무 큽니다."}, 413)
            return

        query = parse_qs(parsed.query)
        model = (query.get("model") or ["htdemucs_ft"])[0]
        if not transcribing:
            if model not in KNOWN_MODELS:
                self._json({"error": f"알 수 없는 모델: {model}"}, 400)
                return
        try:
            shifts = max(0, min(10, int((query.get("shifts") or ["1"])[0])))
            overlap = max(0.0, min(0.9, float((query.get("overlap") or ["0.25"])[0])))
        except ValueError:
            self._json({"error": "shifts/overlap 값이 올바르지 않습니다."}, 400)
            return

        payload = self.rfile.read(length)

        cleanup_old_jobs()
        job = Job(id=uuid.uuid4().hex)
        job.workdir = Path(tempfile.mkdtemp(prefix="bassprac-"))
        # Extension only decides how ffmpeg sniffs it; demucs copes with the common ones.
        suffix = (query.get("ext") or ["wav"])[0]
        suffix = re.sub(r"[^a-z0-9]", "", suffix.lower()) or "wav"
        audio_path = job.workdir / f"input.{suffix}"
        audio_path.write_bytes(payload)

        with JOBS_LOCK:
            JOBS[job.id] = job

        if transcribing:
            threading.Thread(target=run_transcription, args=(job, audio_path), daemon=True).start()
            self._json({"id": job.id, "engine": "basic-pitch"})
            return

        threading.Thread(
            target=run_separation,
            args=(job, audio_path, model, shifts, overlap),
            daemon=True,
        ).start()

        self._json({"id": job.id, "model": model, "shifts": shifts, "overlap": overlap})

    def do_DELETE(self) -> None:
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if not self._origin_allowed():
            self._json({"error": "사이드카는 localhost 주소로 연 앱에서만 쓸 수 있습니다."}, 403)
            return
        if len(parts) == 2 and parts[0] == "jobs":
            with JOBS_LOCK:
                job = JOBS.pop(parts[1], None)
            if job and job.workdir and job.workdir.exists():
                shutil.rmtree(job.workdir, ignore_errors=True)
            self._json({"ok": True})
            return
        self._json({"error": "not found"}, 404)


def main() -> None:
    version = demucs_version()
    print(f"Bass Practice 사이드카  http://{HOST}:{PORT}")
    if version:
        # Name both capabilities on one line. With several Pythons installed it is very easy
        # to pip-install into the interpreter the launcher did NOT pick, and then wonder why
        # the app still says YIN. This line is the answer to that question.
        pitch = basic_pitch_version()
        pitch_note = f"basic-pitch {pitch}" if pitch else "basic-pitch 없음 (채보는 YIN)"
        print(f"  demucs {version} · {pitch_note} · 장치 {torch_device()}")
    else:
        print("  demucs가 아직 없습니다 — 'pip install demucs' 후 다시 실행하세요.")
    ytdlp = ytdlp_version()
    if ytdlp and ytdlp_has_ejs():
        print(f"  yt-dlp {ytdlp} · YouTube 링크 가져오기 사용 가능")
    elif ytdlp:
        print(f"  yt-dlp {ytdlp} · yt-dlp-ejs 없음 — YouTube가 실패하면 'pip install -U \"yt-dlp[default]\"'")
    else:
        print("  yt-dlp 없음 (YouTube 링크 가져오기 꺼짐) — 'pip install -U \"yt-dlp[default]\"'")
    print("  종료하려면 Ctrl+C")

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
