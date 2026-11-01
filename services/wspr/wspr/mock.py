"""Fake spots for offline testing (WSPR_MOCK=1)."""
import math
import random
from datetime import datetime, timedelta, timezone

_RX = [
    ("K9AN", "EN50", 40.1, -88.2), ("G8JNJ", "IO90", 50.9, -1.4), ("VK2KRR", "QF56", -33.6, 151.0),
    ("KD2OM", "FN13", 43.1, -76.1), ("W7WKR", "DN13", 43.6, -116.2), ("JA1PUB", "PM95", 35.6, 139.6),
    ("PY2GN", "GG66", -23.5, -46.6), ("EA8BFK", "IL28", 28.1, -15.4), ("KPH", "CM87", 37.9, -122.7),
    ("ZL2005SWL", "RE78", -41.2, 174.8), ("DK6UG", "JN49", 49.4, 8.6), ("WA2TP", "FN30", 40.9, -72.9),
    ("KJ6MKI", "CM98", 38.6, -121.4), ("VE3EBN", "FN03", 43.6, -79.6), ("TF3HZ", "HP94", 64.1, -21.9),
    ("ZS6KN", "KG44", -25.7, 28.2), ("N8VIM", "EN81", 41.6, -83.6), ("KA7OEI", "DN31", 40.7, -111.9),
    ("WW0WWV", "DM79", 39.9, -105.1), ("KP4MD", "FK68", 18.4, -66.1),
]
_HOME = ("EL98", 28.5, -81.4)


def _dist(a1, o1, a2, o2):
    p = math.pi / 180
    h = (math.sin((a2 - a1) * p / 2) ** 2 +
         math.cos(a1 * p) * math.cos(a2 * p) * math.sin((o2 - o1) * p / 2) ** 2)
    return int(12742 * math.asin(math.sqrt(h)))


def mock_rows(spec):
    rnd = random.Random(hash((spec["call"], spec["band"], spec["hours"])))
    bands = [spec["band"]] if spec["band"] != "all" else [7, 10, 14, 14, 14, 21, 28]
    freqs = {7: 7040100, 10: 10140200, 14: 14097100, 21: 21096100, 28: 28126100,
             1: 1838100, 3: 3570100, 18: 18106100, 24: 24926100, 50: 50294500}
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    now -= timedelta(minutes=now.minute % 2)
    rows = []
    me = spec["call"] or "KN0BLE"
    for i in range(min(spec["limit"], spec["hours"] * 12)):
        t = now - timedelta(minutes=2 * rnd.randint(0, spec["hours"] * 30 - 1))
        b = rnd.choice(bands)
        r = rnd.choice(_RX)
        d = _dist(_HOME[1], _HOME[2], r[2], r[3])
        snr = max(-32, min(10, int(5 - d / 900 + rnd.gauss(0, 6))))
        f = freqs.get(b, 14097100) + rnd.randint(-80, 80)
        if spec["role"] == "tx":
            row = [t.strftime("%Y-%m-%d %H:%M:%S"), b, f, me, _HOME[0] + "ml", _HOME[1], _HOME[2],
                   r[0], r[1], r[2], r[3], d, snr, 23, rnd.choice([0, 0, 0, -1, 1])]
        else:
            row = [t.strftime("%Y-%m-%d %H:%M:%S"), b, f, r[0], r[1], r[2], r[3],
                   me, _HOME[0] + "ml", _HOME[1], _HOME[2], d, snr, rnd.choice([23, 30, 37]), 0]
        rows.append(row)
    for r in rows:
        r[2] = str(r[2])  # mimic ClickHouse quoting UInt64
    rows.sort(key=lambda r: r[0], reverse=True)
    return rows
