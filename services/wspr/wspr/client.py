"""wspr.live client: validated, parameterized, cached, rate-limited.

All user input is validated against strict patterns AND passed to ClickHouse
as typed query parameters ({name:Type}), never interpolated into SQL.
"""
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request

WSPR_LIVE_URL = os.environ.get("WSPR_LIVE_URL", "https://db1.wspr.live/")
MOCK = os.environ.get("WSPR_MOCK") == "1"

CACHE_TTL = 120          # seconds; one WSPR cycle is 2 minutes
MIN_INTERVAL = 3.0       # wspr.live etiquette: <= ~20 req/min
MAX_HOURS = 48
MAX_LIMIT = 2000
USER_AGENT = "KN0BLE.com WSPR viewer"

# wspr.live `band` column codes -> labels
BANDS = {
    -1: "2200m", 0: "630m", 1: "160m", 3: "80m", 5: "60m", 7: "40m",
    10: "30m", 14: "20m", 18: "17m", 21: "15m", 24: "12m", 28: "10m",
    50: "6m", 70: "4m", 144: "2m", 432: "70cm", 1296: "23cm",
}

CALL_RE = re.compile(r"^[A-Z0-9]{1,4}[0-9][A-Z0-9]{0,6}(/[A-Z0-9]{1,4})?$|^[A-Z0-9]{1,4}/[A-Z0-9]{1,4}[0-9][A-Z0-9]{0,6}$")
GRID_RE = re.compile(r"^[A-R]{2}([0-9]{2})?$")

COLUMNS = ("time", "band", "frequency", "tx_sign", "tx_loc", "tx_lat", "tx_lon",
           "rx_sign", "rx_loc", "rx_lat", "rx_lon", "distance", "snr", "power", "drift")


INT_COLS = ("band", "frequency", "distance", "snr", "power", "drift")
FLOAT_COLS = ("tx_lat", "tx_lon", "rx_lat", "rx_lon")


class ValidationError(ValueError):
    pass


class UpstreamError(RuntimeError):
    pass


def validate(args):
    """Turn raw request args into a clean, bounded query spec."""
    call = (args.get("call") or "").strip().upper()
    grid = (args.get("grid") or "").strip()
    grid = grid[:2].upper() + grid[2:4] if grid else ""
    role = (args.get("role") or "tx").lower()
    band = args.get("band", "all")

    if role not in ("tx", "rx"):
        raise ValidationError("role must be tx or rx")
    if call and not CALL_RE.match(call):
        raise ValidationError("invalid callsign")
    if grid and not GRID_RE.match(grid):
        raise ValidationError("grid must be 2 or 4 characters, e.g. EL98")
    if not call and not grid:
        raise ValidationError("enter a callsign or grid")
    if band != "all":
        try:
            band = int(band)
        except (TypeError, ValueError):
            raise ValidationError("invalid band")
        if band not in BANDS:
            raise ValidationError("invalid band")
    try:
        hours = max(1, min(MAX_HOURS, int(args.get("hours", 24))))
        limit = max(1, min(MAX_LIMIT, int(args.get("limit", MAX_LIMIT))))
    except (TypeError, ValueError):
        raise ValidationError("hours/limit must be integers")

    return {"call": call, "grid": grid, "role": role, "band": band,
            "hours": hours, "limit": limit}


def build_query(spec):
    """Return (sql, params). Only fixed SQL fragments are concatenated."""
    side = spec["role"]  # 'tx' or 'rx', validated
    where = ["time > now() - toIntervalHour({hours:UInt16})"]
    params = {"hours": spec["hours"], "limit": spec["limit"]}
    if spec["call"]:
        where.append(f"{side}_sign = {{call:String}}")
        params["call"] = spec["call"]
    if spec["grid"]:
        where.append(f"startsWith({side}_loc, {{grid:String}})")
        params["grid"] = spec["grid"]
    if spec["band"] != "all":
        where.append("band = {band:Int16}")
        params["band"] = spec["band"]
    sql = (f"SELECT {', '.join(COLUMNS)} FROM wspr.rx WHERE {' AND '.join(where)} "
           "ORDER BY time DESC LIMIT {limit:UInt32} FORMAT JSONCompact")
    return sql, params


_cache = {}
_cache_lock = threading.Lock()
_rate_lock = threading.Lock()
_last_call = [0.0]


def _upstream(sql, params):
    # The wspr.live user is already read-only; sending readonly=1 would be
    # rejected as a settings change, so only the query and its params go up.
    qs = {"query": sql}
    qs.update({f"param_{k}": str(v) for k, v in params.items()})
    url = WSPR_LIVE_URL + "?" + urllib.parse.urlencode(qs)
    with _rate_lock:  # serialize upstream calls and space them out
        wait = MIN_INTERVAL - (time.monotonic() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.monotonic()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise UpstreamError(f"wspr.live request failed: {e}") from e


def fetch_spots(spec):
    key = json.dumps(spec, sort_keys=True)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]

    if MOCK:
        from .mock import mock_rows
        rows = mock_rows(spec)
    else:
        sql, params = build_query(spec)
        rows = _upstream(sql, params).get("data", [])

    spots = [dict(zip(COLUMNS, r)) for r in rows]
    for s in spots:
        # JSON output quotes 64-bit ints (frequency) as strings; normalize.
        for k in INT_COLS:
            s[k] = int(s[k])
        for k in FLOAT_COLS:
            s[k] = float(s[k])
        s["band_label"] = BANDS.get(s["band"], str(s["band"]))
    result = {"spots": spots, "truncated": len(spots) >= spec["limit"],
              "fetched_at": int(now), "query": spec}
    with _cache_lock:
        _cache[key] = (now, result)
        if len(_cache) > 500:  # crude bound
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:250]:
                _cache.pop(k, None)
    return result
