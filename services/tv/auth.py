"""Household password for kn0ble.com/stream (the channel menu).

kn0ble.com/tv (the default channel only) is never locked.
TV_PASSWORD (in the kn0ble_com .env) unlocks /stream. A correct password
sets a signed cookie for a year, so each device signs in once. Without
TV_PASSWORD set, nothing unlocks: /stream stays closed rather than open.
TV_AUTH=off switches the lock off completely (for building/testing).

The cookie is "<expiry>.<hmac>", keyed on the password and
TV_PROXY_TOKEN, so changing the password signs every device out.
nginx asks /tv/live/auth before serving the /stream page itself; the relay
checks the same cookie on its own endpoints.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import threading
import time
from http.cookies import CookieError, SimpleCookie

COOKIE = "tvauth"
MAX_AGE = 365 * 24 * 3600
FAIL_LIMIT = 5          # wrong passwords per IP ...
FAIL_WINDOW = 15 * 60   # ... per 15 minutes

_fails: dict[str, list[float]] = {}
_lock = threading.Lock()


def disabled() -> bool:
    """TV_AUTH=off turns the lock off entirely (while building/testing).
    Anything else, or unset, keeps it on."""
    return os.environ.get("TV_AUTH", "on").strip().lower() == "off"


def password() -> str:
    return os.environ.get("TV_PASSWORD", "")


def _key() -> bytes:
    return hashlib.sha256(("tv:" + password() + ":" + os.environ.get("TV_PROXY_TOKEN", "")).encode()).digest()


def _sign(exp: int) -> str:
    return hmac.new(_key(), str(exp).encode(), hashlib.sha256).hexdigest()


def make_cookie(now: float | None = None) -> str:
    exp = int((now or time.time()) + MAX_AGE)
    return f"{exp}.{_sign(exp)}"


def cookie_ok(cookie_header: str | None, now: float | None = None) -> bool:
    if disabled():
        return True
    if not password() or not cookie_header:
        return False
    try:
        jar = SimpleCookie(cookie_header)
    except CookieError:
        return False
    morsel = jar.get(COOKIE)
    if morsel is None or "." not in morsel.value:
        return False
    exp_s, sig = morsel.value.split(".", 1)
    if not exp_s.isdigit() or int(exp_s) < (now or time.time()):
        return False
    return hmac.compare_digest(sig, _sign(int(exp_s)))


def set_cookie_header(secure: bool) -> str:
    flags = f"Path=/; Max-Age={MAX_AGE}; HttpOnly; SameSite=Lax"
    return f"{COOKIE}={make_cookie()}; {flags}" + ("; Secure" if secure else "")


def clear_cookie_header(secure: bool) -> str:
    return f"{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" + ("; Secure" if secure else "")


def blocked(ip: str, now: float | None = None) -> bool:
    now = now or time.time()
    with _lock:
        recent = [t for t in _fails.get(ip, []) if now - t < FAIL_WINDOW]
        _fails[ip] = recent
        return len(recent) >= FAIL_LIMIT


def note_failure(ip: str) -> None:
    with _lock:
        _fails.setdefault(ip, []).append(time.time())


def check_password(given: str) -> bool:
    pw = password()
    return bool(pw) and hmac.compare_digest(given.encode(), pw.encode())
