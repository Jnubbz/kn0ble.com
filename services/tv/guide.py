"""XMLTV program guide for kn0ble.com/tv ("Now" / "Next").

The guide URL and the channel list come from qsl-tracker's internal
config. The file is streamed and parsed with iterparse (never held in
memory whole; .xml or .xml.gz), keeping only programmes for channels in
the list and only the next ~30 hours. Refreshed every 6 hours, or at
once when the URL or the channel list changes. Refreshes run in a
background thread kicked off by a /tv/live/guide.json request, so
nothing is downloaded while nobody visits /tv.

Matching: a channel's guide id (tvg-id from the .m3u, or set by hand) is
looked up as the XMLTV channel id; with no guide id, the channel's name
is matched against the guide's <display-name>s (case-insensitive).
"""
from __future__ import annotations

import gzip
import io
import logging
import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

log = logging.getLogger("tvproxy.guide")

REFRESH_SECONDS = 6 * 3600
RETRY_SECONDS = 15 * 60
KEEP_PAST = 3600            # keep programmes that ended up to 1 h ago
KEEP_AHEAD = 30 * 3600      # and those starting in the next 30 h
MAX_BYTES = 800 * 1024 * 1024  # decompressed cap
TIMEOUT = 60
USER_AGENT = "kn0ble-tv/1.0 (+https://kn0ble.com)"

_TIME_RE = re.compile(r"^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?")


def parse_time(value: str | None) -> float | None:
    """XMLTV time ("20261112173000 +0000") -> unix seconds. No zone = UTC."""
    m = _TIME_RE.match(value or "")
    if not m:
        return None
    y, mo, d, h, mi, s, tz = m.groups()
    offset = timezone.utc
    if tz:
        sign = 1 if tz[0] == "+" else -1
        offset = timezone(sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5])))
    try:
        return datetime(int(y), int(mo), int(d), int(h), int(mi), int(s or 0), tzinfo=offset).timestamp()
    except ValueError:
        return None


class _Capped(io.RawIOBase):
    """Stops reading after MAX_BYTES so a runaway file can't fill memory/time."""

    def __init__(self, raw, limit):
        self.raw, self.left = raw, limit

    def readable(self):
        return True

    def readinto(self, b):
        if self.left <= 0:
            raise ValueError("guide file is too large")
        n = self.raw.readinto(memoryview(b)[: min(len(b), self.left)])
        self.left -= n or 0
        return n


def _text(elem, tag, limit):
    child = elem.find(tag)
    if child is None or not child.text:
        return ""
    return re.sub(r"\s+", " ", child.text).strip()[:limit]


def parse_xmltv(stream, wanted_ids: set[str], wanted_names: set[str], now: float) -> dict[str, list]:
    """{key: [(start, stop, title, subtitle, desc), ...] sorted}. Keys are
    guide ids from wanted_ids, or "name:<lower name>" for name matches."""
    lo, hi = now - KEEP_PAST, now + KEEP_AHEAD
    name_key: dict[str, str] = {}  # xmltv channel id -> "name:<n>"
    out: dict[str, list] = {}
    root = None
    for event, elem in ET.iterparse(stream, events=("start", "end")):
        if event == "start":
            if root is None:
                root = elem
            continue
        if elem.tag == "channel":
            cid = elem.get("id", "")
            if cid and cid not in wanted_ids:
                for dn in elem.findall("display-name"):
                    n = (dn.text or "").strip().lower()
                    if n in wanted_names:
                        name_key[cid] = "name:" + n
                        break
        elif elem.tag == "programme":
            cid = elem.get("channel", "")
            key = cid if cid in wanted_ids else name_key.get(cid)
            if key:
                start, stop = parse_time(elem.get("start")), parse_time(elem.get("stop"))
                if start is not None:
                    if stop is None or stop <= start:
                        stop = start + 1800
                    if stop >= lo and start <= hi:
                        out.setdefault(key, []).append((
                            start, stop, _text(elem, "title", 200) or "Untitled",
                            _text(elem, "sub-title", 200), _text(elem, "desc", 400)))
        else:
            continue
        if root is not None:
            root.clear()  # drop finished <channel>/<programme> elements
    for progs in out.values():
        progs.sort()
    return out


class Guide:
    def __init__(self):
        self.lock = threading.Lock()
        self.url = ""
        self.wanted: tuple = ()
        self.progs: dict[str, list] = {}
        self.updated = 0.0
        self.next_try = 0.0
        self.loading = False
        self.error = ""

    def _fetch(self, url: str, wanted_ids: set, wanted_names: set) -> dict:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            buf = io.BufferedReader(_Capped(resp, MAX_BYTES), 1 << 16)
            if buf.peek(2)[:2] == b"\x1f\x8b":  # .xml.gz, or gzip transfer
                stream = io.BufferedReader(_Capped(gzip.GzipFile(fileobj=buf), MAX_BYTES), 1 << 16)
            else:
                stream = buf
            return parse_xmltv(stream, wanted_ids, wanted_names, time.time())

    def _refresh(self, url: str, wanted: tuple) -> None:
        ids = {e for e, _n in wanted if e}
        names = {n for e, n in wanted if not e and n}
        t0 = time.time()
        try:
            progs = self._fetch(url, ids, names)
            with self.lock:
                if self.url == url and self.wanted == wanted:
                    self.progs, self.updated, self.error = progs, time.time(), ""
            log.info("guide loaded: %d channels matched in %.1fs", len(progs), time.time() - t0)
        except Exception as exc:  # network, gzip, XML, size
            log.error("guide load failed: %s", exc)
            with self.lock:
                if self.url == url:
                    self.error = str(exc)[:200]
                    self.next_try = time.time() + RETRY_SECONDS
        finally:
            with self.lock:
                self.loading = False

    def maybe_refresh(self, url: str, epg_channels: list[dict]) -> None:
        """Start a background refresh if the URL or channel list changed,
        the data is old, or a failed load is due a retry."""
        wanted = tuple(sorted({((c.get("epg_id") or "").strip(),
                                "" if c.get("epg_id") else (c.get("name") or "").strip().lower())
                               for c in epg_channels}))
        with self.lock:
            if not url:
                self.url, self.progs, self.error, self.updated = "", {}, "", 0.0
                return
            changed = url != self.url or wanted != self.wanted
            if url != self.url:
                # A different guide: the old one's shows no longer apply.
                self.progs, self.updated = {}, 0.0
            if changed:
                self.url, self.wanted, self.next_try, self.error = url, wanted, 0.0, ""
            due = changed or (time.time() - self.updated > REFRESH_SECONDS and time.time() >= self.next_try)
            if self.loading or not due:
                return
            self.loading = True
        threading.Thread(target=self._refresh, args=(url, wanted), daemon=True).start()

    def is_loading(self) -> bool:
        """True while a guide is set but its first load hasn't finished."""
        with self.lock:
            return bool(self.url) and not self.updated and (self.loading or not self.error)

    def now_title(self, channel: dict, now: float | None = None) -> str:
        """Title on now for one channel, or "" (cheap; for the menu)."""
        now = time.time() if now is None else now
        epg_id = (channel.get("epg_id") or "").strip()
        key = epg_id if epg_id else "name:" + (channel.get("name") or "").strip().lower()
        with self.lock:
            progs = self.progs.get(key, [])
        for p in progs:
            if p[0] <= now < p[1]:
                return p[2]
            if p[0] > now:
                break
        return ""

    def lookup(self, channel: dict | None, now: float | None = None) -> dict:
        """Now/next for one channel, for /tv/live/guide.json."""
        now = time.time() if now is None else now
        with self.lock:
            url, loading, error, updated = self.url, self.loading, self.error, self.updated
            progs_all = self.progs
        if not url:
            return {"status": "off"}
        if not channel:
            return {"status": "no-channel"}
        if not updated:
            return {"status": "error", "error": error} if error and not loading else {"status": "loading"}
        epg_id = (channel.get("epg_id") or "").strip()
        key = epg_id if epg_id else "name:" + (channel.get("name") or "").strip().lower()
        progs = progs_all.get(key, [])
        cur = nxt = None
        for p in progs:
            if p[0] <= now < p[1]:
                cur = p
            elif p[0] >= now:
                nxt = p
                break
        if not cur and not nxt:
            return {"status": "no-match" if not progs else "no-data", "updated": int(updated)}

        def js(p):
            return None if not p else {"start": int(p[0]), "stop": int(p[1]), "title": p[2], "subtitle": p[3], "desc": p[4]}

        return {"status": "ok", "updated": int(updated), "now": js(cur), "next": js(nxt)}
