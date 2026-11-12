"""Stream relay for kn0ble.com/tv.

kn0ble-com's nginx proxies /tv/live/ here. When someone opens /tv, the
page asks for /tv/live/index.m3u8; this service looks up the channel
that's "on TV" (qsl-tracker's token-protected internal config), starts
ffmpeg on it, and serves the HLS that ffmpeg writes. So the browser
only ever talks to kn0ble.com: http:// sources, raw MPEG-TS, CORS and
credentials in the URL all stop mattering.

- Only the active channel is ever fetched. There is no URL parameter,
  so this can't be used as an open proxy.
- ffmpeg runs only while someone is watching: no playlist/segment
  request for IDLE_SECONDS stops it (IPTV accounts often allow one
  connection).
- Video is copied as-is (no CPU cost); audio is re-encoded to AAC so
  AC-3/MP2 sources play in browsers. TV_TRANSCODE=1 re-encodes video to
  H.264 too, for HEVC or other sources browsers can't play.

Standard library only; ffmpeg comes from the image.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG_URL = os.environ.get("TV_CONFIG_URL", "http://qsl-tracker:8000/tv-config-internal.json")
TOKEN = os.environ.get("TV_PROXY_TOKEN", "")
HLS_ROOT = Path(os.environ.get("TV_HLS_DIR", "/tmp/tv-hls"))
IDLE_SECONDS = float(os.environ.get("TV_IDLE_SECONDS", "45"))
START_WAIT = float(os.environ.get("TV_START_WAIT", "20"))
CONFIG_TTL = float(os.environ.get("TV_CONFIG_TTL", "5"))
TRANSCODE = os.environ.get("TV_TRANSCODE", "0") == "1"
USER_AGENT = os.environ.get("TV_USER_AGENT", "VLC/3.0.20 LibVLC/3.0.20")
FFMPEG = os.environ.get("TV_FFMPEG", "ffmpeg")
PORT = int(os.environ.get("PORT", "8000"))

PREFIX = "/tv/live/"
SEG_RE = re.compile(r"^g(\d{1,9})/seg(\d{1,9})\.ts$")

log = logging.getLogger("tvproxy")


class Relay:
    def __init__(self):
        self.lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.url: str | None = None
        self.gen = 0
        self.dir: Path | None = None
        self.last_access = 0.0
        self.last_start = 0.0
        self.stderr_tail: deque[str] = deque(maxlen=20)
        self._cfg = (0.0, None)

    # -- config ------------------------------------------------------
    def channel(self) -> dict | None:
        """The active channel {id, name, url} or None; cached briefly."""
        at, ch = self._cfg
        if time.monotonic() - at < CONFIG_TTL:
            return ch
        req = urllib.request.Request(CONFIG_URL, headers={"X-TV-Token": TOKEN})
        with urllib.request.urlopen(req, timeout=5) as resp:
            ch = json.load(resp).get("channel")
        self._cfg = (time.monotonic(), ch)
        return ch

    # -- ffmpeg ------------------------------------------------------
    def _cmd(self, url: str, out: Path) -> list[str]:
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "warning", "-nostdin"]
        if url.lower().startswith(("http://", "https://")):
            cmd += ["-user_agent", USER_AGENT, "-reconnect", "1", "-reconnect_streamed", "1",
                    "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5"]
        cmd += ["-i", url, "-map", "0:v:0?", "-map", "0:a:0?"]
        if TRANSCODE:
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
                    "-g", "50", "-sc_threshold", "0"]
        else:
            cmd += ["-c:v", "copy"]
        cmd += ["-c:a", "aac", "-b:a", "128k", "-ac", "2",
                "-f", "hls", "-hls_time", "4", "-hls_list_size", "6",
                "-hls_flags", "delete_segments+omit_endlist+temp_file+independent_segments",
                "-hls_base_url", f"g{self.gen}/",
                "-hls_segment_filename", str(out / "seg%05d.ts"),
                str(out / "index.m3u8")]
        return cmd

    def _drain(self, proc: subprocess.Popen) -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            line = line.decode("utf-8", "replace").rstrip()
            if line:
                self.stderr_tail.append(line)
                log.warning("ffmpeg: %s", line)

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self, reason: str = "") -> None:
        with self.lock:
            if self.proc is not None:
                if self.proc.poll() is None:
                    self.proc.terminate()
                    try:
                        self.proc.wait(5)
                    except subprocess.TimeoutExpired:
                        self.proc.kill()
                log.info("stopped relay%s", f" ({reason})" if reason else "")
            self.proc = None
            self.url = None
            if self.dir is not None:
                shutil.rmtree(self.dir, ignore_errors=True)
                self.dir = None

    def ensure(self, url: str) -> None:
        """Make sure ffmpeg is running on `url`."""
        with self.lock:
            if self.running() and self.url == url:
                return
            # Don't hammer a dead source: at most one start per 5 s.
            wait = 5 - (time.monotonic() - self.last_start)
            if self.url == url and wait > 0:
                time.sleep(wait)
            self.stop("channel changed" if self.url and self.url != url else "")
            self.gen += 1
            self.dir = HLS_ROOT / f"g{self.gen}"
            self.dir.mkdir(parents=True, exist_ok=True)
            self.stderr_tail.clear()
            self.proc = subprocess.Popen(self._cmd(url, self.dir), stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            threading.Thread(target=self._drain, args=(self.proc,), daemon=True).start()
            self.url = url
            self.last_start = time.monotonic()
            log.info("started relay g%d", self.gen)

    def playlist(self) -> tuple[int, bytes, str]:
        """(status, body, content type) for /tv/live/index.m3u8."""
        self.last_access = time.monotonic()
        try:
            ch = self.channel()
        except Exception as exc:  # qsl-tracker down or token wrong
            log.error("config fetch failed: %s", exc)
            return 503, b"channel setting unavailable\n", "text/plain"
        if not ch or not ch.get("url"):
            self.stop("nothing on TV")
            return 404, b"nothing on TV\n", "text/plain"
        self.ensure(ch["url"])
        deadline = time.monotonic() + START_WAIT
        while time.monotonic() < deadline:
            with self.lock:
                proc, d = self.proc, self.dir
            if d is not None and (d / "index.m3u8").is_file():
                self.last_access = time.monotonic()
                return 200, (d / "index.m3u8").read_bytes(), "application/vnd.apple.mpegurl"
            if proc is None or proc.poll() is not None:
                detail = self.stderr_tail[-1] if self.stderr_tail else "ffmpeg exited"
                return 502, f"stream failed to start: {detail}\n".encode(), "text/plain"
            time.sleep(0.25)
        return 504, b"stream is taking too long to start\n", "text/plain"

    def segment(self, rel: str) -> Path | None:
        m = SEG_RE.match(rel)
        if not m:
            return None
        self.last_access = time.monotonic()
        with self.lock:
            if self.dir is None or int(m.group(1)) != self.gen:
                return None
            p = self.dir / f"seg{m.group(2)}.ts"
        return p if p.is_file() else None

    def watchdog(self) -> None:
        while True:
            time.sleep(5)
            if self.proc is not None and time.monotonic() - self.last_access > IDLE_SECONDS:
                self.stop("nobody watching")


relay = Relay()


class Handler(BaseHTTPRequestHandler):
    server_version = "kn0ble-tv"
    sys_version = ""

    def _send(self, status: int, body: bytes, ctype: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/healthz", PREFIX + "healthz"):
            return self._send(200, b"ok\n", "text/plain")
        if not path.startswith(PREFIX):
            return self._send(404, b"not found\n", "text/plain")
        rel = path[len(PREFIX):]
        if rel == "index.m3u8":
            status, body, ctype = relay.playlist()
            return self._send(status, body, ctype)
        p = relay.segment(rel)
        if p is None:
            return self._send(404, b"not found\n", "text/plain")
        try:
            body = p.read_bytes()
        except FileNotFoundError:  # deleted between check and read
            return self._send(404, b"not found\n", "text/plain")
        return self._send(200, body, "video/mp2t", cache="max-age=60")

    do_HEAD = do_GET

    def log_message(self, fmt, *args):
        if "/healthz" not in self.path:
            log.info("%s %s", self.address_string(), fmt % args)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not TOKEN:
        log.warning("TV_PROXY_TOKEN is not set; qsl-tracker will refuse the config request")
    shutil.rmtree(HLS_ROOT, ignore_errors=True)
    HLS_ROOT.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=relay.watchdog, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
