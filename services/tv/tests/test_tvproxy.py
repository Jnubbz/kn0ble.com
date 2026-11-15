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
    channels = []
    token_seen = None
    requests = 0
    not_modified = 0


class ConfigHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        Config.token_seen = self.headers.get("X-TV-Token")
        Config.requests += 1
        etag = '"%d"' % hash(json.dumps([Config.channel, Config.channels], sort_keys=True))
        if self.headers.get("If-None-Match") == etag:
            Config.not_modified += 1
            self.send_response(304); self.send_header("ETag", etag); self.end_headers()
            return
        body = json.dumps({"channel": Config.channel, "channels": Config.channels,
                           "active": Config.channel and Config.channel["id"],
                           "epg_url": "", "epg_channels": []}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("ETag", etag); self.end_headers()
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
        TV_IDLE_SECONDS="2", TV_START_WAIT="5", PORT=str(port),
        TV_PASSWORD="hunter2", TV_COOKIE_SECURE="0")
    import tvproxy
    tvproxy.HLS_ROOT.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), tvproxy.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    threading.Thread(target=tvproxy.relay.watchdog, daemon=True).start()
    yield {"base": f"http://127.0.0.1:{port}", "tv": tvproxy, "log": tmp / "hls" / "inputs.log"}
    tvproxy.relay.stop()
    srv.shutdown(); cfg.shutdown()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(url, cookie=True, data=None, headers=None):
    import auth
    h = dict(headers or {})
    if cookie:
        h["Cookie"] = "tvauth=" + auth.make_cookie()
    req = urllib.request.Request(url, data=data, headers=h)
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=10) as r:
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
    status, data, headers = get(env["base"] + seg)
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


def test_locked_without_cookie(env):
    Config.channel = {"id": "aa", "name": "A", "url": "http://src.example/a"}
    Config.channels = [Config.channel]
    # The /stream menu needs the cookie ...
    for path in ("/tv/live/channels.json", "/tv/live/ch/aa/index.m3u8", "/tv/live/guide.json?ch=aa"):
        assert get(env["base"] + path, cookie=False)[0] == 401, path
    # ... the /tv default channel never does.
    status, body, _ = get(env["base"] + "/tv/live/index.m3u8", cookie=False)
    assert status == 200
    seg = [l for l in body.decode().splitlines() if l.endswith(".ts")][0]
    assert get(env["base"] + seg, cookie=False)[0] == 200
    assert get(env["base"] + "/tv/live/guide.json", cookie=False)[0] == 200
    assert get(env["base"] + "/tv/live/auth", cookie=False)[0] == 401
    assert get(env["base"] + "/tv/live/auth")[0] == 204
    assert get(env["base"] + "/tv/live/auth", cookie=False, headers={"Cookie": "tvauth=9999999999.forged"})[0] == 401
    assert get(env["base"] + "/tv/live/healthz", cookie=False)[0] == 200


def login(env, pw, ip):
    return get(env["base"] + "/tv/live/login", cookie=False, data=f"password={pw}".encode(),
               headers={"CF-Connecting-IP": ip, "Content-Type": "application/x-www-form-urlencoded"})


def test_login_flow_and_rate_limit(env):
    status, _, h = login(env, "hunter2", "10.0.0.1")
    assert status == 303 and h["Location"] == "/stream/"
    cookie = h["Set-Cookie"]
    assert "HttpOnly" in cookie and "Path=/;" in cookie and "Max-Age=31536000" in cookie
    value = cookie.split(";")[0]
    assert get(env["base"] + "/tv/live/auth", cookie=False, headers={"Cookie": value})[0] == 204
    status, _, h = login(env, "wrong", "10.0.0.2")
    assert h["Location"] == "/stream/login.html?bad=1"
    for _ in range(5):
        login(env, "wrong", "10.0.0.3")
    # Locked out even with the right password now; other IPs unaffected.
    assert login(env, "hunter2", "10.0.0.3")[2]["Location"] == "/stream/login.html?wait=1"
    assert login(env, "hunter2", "10.0.0.4")[2]["Location"] == "/stream/"
    status, _, h = get(env["base"] + "/tv/live/logout")
    assert h["Location"] == "/stream/login.html" and "Max-Age=0" in h["Set-Cookie"]


def test_no_password_means_locked(env, monkeypatch):
    monkeypatch.setenv("TV_PASSWORD", "")
    assert get(env["base"] + "/tv/live/auth")[0] == 401
    assert login(env, "", "10.0.0.9")[2]["Location"] == "/stream/login.html?unset=1"


def test_channel_menu_hides_vod_and_urls(env):
    Config.channel = None
    Config.channels = [
        {"id": "aa", "name": "News", "group": "US News", "logo": "https://l/n.png", "url": "http://src/U/P/1", "epg_id": ""},
        {"id": "bb", "name": "Weather", "group": "", "logo": "http://l/w.png", "url": "http://src/U/P/2", "epg_id": ""},
        {"id": "cc", "name": "A Movie", "group": "Movies", "url": "http://src/movie/U/P/3.mkv", "epg_id": ""},
        {"id": "dd", "name": "Ep 1", "group": "Shows", "url": "http://src/series/U/P/4.mp4", "epg_id": ""},
    ]
    status, body, _ = get(env["base"] + "/tv/live/channels.json")
    data = json.loads(body)
    assert status == 200 and [c["id"] for c in data["channels"]] == ["aa", "bb"]
    assert data["active"] == "aa"
    assert data["locked"] is True
    assert data["channels"][1]["logo"] == ""  # http logo dropped
    assert b"src/" not in body and b"U/P" not in body


def test_pick_channel_switches_relay(env):
    Config.channels = [
        {"id": "aa", "name": "News", "url": "http://src.example/ch/aa"},
        {"id": "bb", "name": "Weather", "url": "http://src.example/ch/bb"},
    ]
    assert get(env["base"] + "/tv/live/ch/aa/index.m3u8")[0] == 200
    assert env["log"].read_text().splitlines()[-1] == "http://src.example/ch/aa"
    status, body, _ = get(env["base"] + "/tv/live/ch/bb/index.m3u8")
    assert status == 200
    # Segment links are absolute, so they resolve from /ch/<id>/ too.
    seg = [l for l in body.decode().splitlines() if l.endswith(".ts")][0]
    assert seg.startswith("/tv/live/g")
    assert get(env["base"] + seg)[0] == 200
    assert env["log"].read_text().splitlines()[-1] == "http://src.example/ch/bb"
    assert get(env["base"] + "/tv/live/ch/ff/index.m3u8")[0] == 404
    assert get(env["base"] + "/tv/live/ch/../index.m3u8")[0] in (401, 404)


def test_auth_off_switch(env, monkeypatch):
    monkeypatch.setenv("TV_AUTH", "off")
    assert get(env["base"] + "/tv/live/auth", cookie=False)[0] == 204
    assert get(env["base"] + "/tv/live/channels.json", cookie=False)[0] == 200
    assert login(env, "", "10.0.0.20")[2]["Location"] == "/stream/"
    monkeypatch.setenv("TV_AUTH", "on")
    assert get(env["base"] + "/tv/live/auth", cookie=False)[0] == 401


def test_config_uses_etag(env):
    Config.channel = {"id": "aa", "name": "A", "url": "http://src.example/a"}
    Config.channels = [Config.channel]
    env["tv"].relay._cfg = (0.0, None)
    env["tv"].relay._etag = None
    before = Config.not_modified
    assert env["tv"].relay.config()["channel"]["id"] == "aa"
    cfg = env["tv"].relay.config()  # TTL 0: asks again, gets 304, keeps data
    assert Config.not_modified == before + 1 and cfg["channel"]["id"] == "aa"
    Config.channel = {"id": "bb", "name": "B", "url": "http://src.example/b"}
    Config.channels = [Config.channel]
    assert env["tv"].relay.config()["channel"]["id"] == "bb"  # changed: full fetch
