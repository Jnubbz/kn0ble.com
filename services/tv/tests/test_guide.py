"""XMLTV guide: time parsing, streaming parse, matching, now/next."""
import gzip
import io
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import guide as g  # noqa: E402

NOW = 1_800_000_000  # fixed "now" for parse tests


def ts(t):
    return time.strftime("%Y%m%d%H%M%S +0000", time.gmtime(t))


def xmltv(now):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
  <channel id="news.us"><display-name>Example News</display-name></channel>
  <channel id="wx.1"><display-name lang="en">Weather 24/7</display-name><display-name>WX</display-name></channel>
  <channel id="other"><display-name>Other</display-name></channel>
  <programme start="{ts(now - 7200)}" stop="{ts(now - 5000)}" channel="news.us"><title>Too old</title></programme>
  <programme start="{ts(now - 600)}" stop="{ts(now + 1200)}" channel="news.us">
    <title lang="en">Evening   News</title><sub-title>Part 2</sub-title><desc>Headlines &amp; weather.</desc></programme>
  <programme start="{ts(now + 1200)}" stop="{ts(now + 3000)}" channel="news.us"><title>Late Show</title></programme>
  <programme start="{ts(now + 200000)}" stop="{ts(now + 203600)}" channel="news.us"><title>Too far</title></programme>
  <programme start="{ts(now - 100)}" stop="{ts(now + 100)}" channel="wx.1"><title>Radar</title></programme>
  <programme start="{ts(now - 100)}" stop="{ts(now + 100)}" channel="other"><title>Ignored</title></programme>
</tv>""".encode()


def test_parse_time_zones():
    assert g.parse_time("20261112173000 +0000") == g.parse_time("20261112123000 -0500")
    assert g.parse_time("202611121730") == g.parse_time("20261112173000 +0000")
    assert g.parse_time("garbage") is None and g.parse_time(None) is None


def test_parse_by_id_and_name_and_window():
    out = g.parse_xmltv(io.BytesIO(xmltv(NOW)), {"news.us"}, {"wx"}, NOW)
    assert set(out) == {"news.us", "name:wx"}
    titles = [p[2] for p in out["news.us"]]
    assert titles == ["Evening News", "Late Show"]  # too old / too far dropped, whitespace tidied
    assert out["news.us"][0][3:] == ("Part 2", "Headlines & weather.")


def lookup(progs, ch, now):
    gd = g.Guide()
    gd.url, gd.updated, gd.progs = "http://x", 1.0, progs
    return gd.lookup(ch, now)


def test_lookup_now_next():
    progs = g.parse_xmltv(io.BytesIO(xmltv(NOW)), {"news.us"}, {"weather 24/7"}, NOW)
    r = lookup(progs, {"name": "News", "epg_id": "news.us"}, NOW)
    assert r["status"] == "ok" and r["now"]["title"] == "Evening News" and r["next"]["title"] == "Late Show"
    r = lookup(progs, {"name": "Weather 24/7", "epg_id": ""}, NOW)
    assert r["now"]["title"] == "Radar" and r["next"] is None
    assert lookup(progs, {"name": "Nope", "epg_id": ""}, NOW)["status"] == "no-match"
    assert g.Guide().lookup({"name": "x"})["status"] == "off"


class Src(BaseHTTPRequestHandler):
    body = b""

    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(Src.body)

    def log_message(self, *a):
        pass


def wait_loaded(gd, ch, secs=10):
    end = time.time() + secs
    while time.time() < end:
        r = gd.lookup(ch)
        if r["status"] not in ("loading",):
            return r
        time.sleep(0.1)
    return r


def test_fetch_gzip_refresh_and_errors():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Src)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/epg.xml.gz"
    try:
        Src.body = gzip.compress(xmltv(time.time()))
        gd = g.Guide()
        chans = [{"epg_id": "news.us", "name": "News"}, {"epg_id": "", "name": "WX"}]
        gd.maybe_refresh(url, chans)
        r = wait_loaded(gd, {"epg_id": "news.us", "name": "News"})
        assert r["status"] == "ok" and r["now"]["title"] == "Evening News"
        assert gd.lookup({"epg_id": "", "name": "wx"})["now"]["title"] == "Radar"
        # Broken XML at a new URL: error reported, no crash.
        Src.body = b"<tv><programme"
        gd.maybe_refresh(url + "?v=2", chans)
        r = wait_loaded(gd, {"epg_id": "news.us", "name": "News"})
        assert r["status"] == "error" and r["error"]
        # Removing the URL turns the guide off.
        gd.maybe_refresh("", chans)
        assert gd.lookup({"epg_id": "news.us"})["status"] == "off"
    finally:
        srv.shutdown()
