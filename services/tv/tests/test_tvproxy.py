"""kn0ble-tv relay: fake ffmpeg + fake qsl-tracker config, real HTTP."""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

# A stand-in for ffmpeg: writes a playlist + one segment where the real
# one would, records its input URL, then idles until terminated. If the
# URL contains "dead" it exits at once with an error, like a bad source.
FAKE = r'''#!/usr/bin/env python3
import sys, time, pathlib
args = sys.argv[1:]
url = args[args.index("-i") + 1]
out = pathlib.Path(args[-1])
log = pathlib.Path(out.parent.parent / "inputs.log")
with log.open("a") as f: f.write(url + "\n")
if "dead" in url:
    sys.stderr.write("Server returned 404 Not Found\n"); sys.exit(1)
base = args[args.index("-hls_base_url") + 1]
time.sleep(0.3)
(out.parent / "seg00000.ts").write_bytes(b"\x47" * 188)
out.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n" + base + "seg00000.ts\n")
while True: time.sleep(1)
'''


class Config:
    channel = None
    token_seen = None


class ConfigHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        Config.token_seen = self.headers.get("X-TV-Token")
        body = json.dumps({"channel": Config.channel}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def free_port():
    import socket
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("tv")
    fake = tmp / "ffmpeg"; fake.write_text(FAKE); fake.chmod(0o755)
    cfg_port, port = free_port(), free_port()
    cfg = ThreadingHTTPServer(("127.0.0.1", cfg_port), ConfigHandler)
    threading.Thread(target=cfg.serve_forever, daemon=True).start()
    os.environ.update(
        TV_CONFIG_URL=f"http://127.0.0.1:{cfg_port}/", TV_PROXY_TOKEN="tok",
        TV_HLS_DIR=str(tmp / "hls"), TV_FFMPEG=str(fake), TV_CONFIG_TTL="0",
        TV_IDLE_SECONDS="2", TV_START_WAIT="5", PORT=str(port))
    import tvproxy
    tvproxy.HLS_ROOT.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), tvproxy.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=tvproxy.relay.watchdog, daemon=True).start()
    yield {"base": f"http://127.0.0.1:{port}", "tv": tvproxy, "log": tmp / "hls" / "inputs.log"}
    tvproxy.relay.stop()
    srv.shutdown(); cfg.shutdown()


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def test_nothing_on_tv(env):
    Config.channel = None
    status, body, _ = get(env["base"] + "/tv/live/index.m3u8")
    assert status == 404 and b"nothing on TV" in body
    assert Config.token_seen == "tok"


def test_plays_active_channel_and_serves_segment(env):
    Config.channel = {"id": "a", "name": "A", "url": "http://src.example/USER/PASS/1"}
    status, body, headers = get(env["base"] + "/tv/live/index.m3u8")
    assert status == 200
    assert headers["Content-Type"] == "application/vnd.apple.mpegurl"
    assert headers["Cache-Control"] == "no-store"
    assert b"PASS" not in body
    seg = [l for l in body.decode().splitlines() if l.endswith(".ts")][0]
    status, data, headers = get(env["base"] + "/tv/live/" + seg)
    assert status == 200 and data.startswith(b"\x47") and headers["Content-Type"] == "video/mp2t"


def test_no_open_proxy_or_traversal(env):
    for path in ("/tv/live/../tvproxy.py", "/tv/live/g1/../../x.ts", "/tv/live/index.m3u8x",
                 "/tv/live/g999/seg00000.ts", "/other"):
        assert get(env["base"] + path)[0] == 404
    # A url parameter is ignored: only the active channel is fetched.
    get(env["base"] + "/tv/live/index.m3u8?url=http://evil.example/")
    assert "evil" not in env["log"].read_text()


def test_switches_channel(env):
    Config.channel = {"id": "b", "name": "B", "url": "http://src.example/2"}
    gen_before = env["tv"].relay.gen
    status, body, _ = get(env["base"] + "/tv/live/index.m3u8")
    assert status == 200
    assert env["tv"].relay.gen == gen_before + 1
    assert f"g{gen_before + 1}/".encode() in body
    assert env["log"].read_text().splitlines()[-1] == "http://src.example/2"


def test_stops_when_idle(env):
    Config.channel = {"id": "b", "name": "B", "url": "http://src.example/2"}
    assert get(env["base"] + "/tv/live/index.m3u8")[0] == 200
    assert env["tv"].relay.running()
    time.sleep(8)
    assert not env["tv"].relay.running()
    assert get(env["base"] + "/tv/live/index.m3u8")[0] == 200  # restarts on demand


def test_dead_source_reports_error(env):
    Config.channel = {"id": "d", "name": "D", "url": "http://dead.example/x"}
    status, body, _ = get(env["base"] + "/tv/live/index.m3u8")
    assert status == 502 and b"404 Not Found" in body


def test_healthz(env):
    assert get(env["base"] + "/healthz")[0] == 200
