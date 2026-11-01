import os
import sys

os.environ["WSPR_MOCK"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app import app  # noqa: E402
from wspr.client import ValidationError, build_query, validate  # noqa: E402


@pytest.fixture
def c():
    return app.test_client()


def test_page(c):
    r = c.get("/wspr/")
    assert r.status_code == 200 and b"WSPR" in r.data


def test_spots(c):
    r = c.get("/wspr/api/spots?call=kn0ble&band=14&hours=6")
    j = r.get_json()
    assert r.status_code == 200 and j["spots"]
    assert all(s["band"] == 14 and s["tx_sign"] == "KN0BLE" for s in j["spots"])


@pytest.mark.parametrize("q", [
    "call=KN0BLE'%20OR%201=1--", "call=", "call=KN0BLE&band=13", "call=KN0BLE&role=both",
    "grid=ZZ99", "call=KN0BLE&hours=abc", "call=" + "A" * 30,
])
def test_rejects(c, q):
    assert c.get("/wspr/api/spots?" + q).status_code == 400


def test_clamps():
    s = validate({"call": "KN0BLE", "hours": "9999", "limit": "999999"})
    assert s["hours"] == 48 and s["limit"] == 2000


def test_portable_calls():
    for call in ("KN0BLE/P", "VE3/KN0BLE", "K1A"):
        validate({"call": call})
    with pytest.raises(ValidationError):
        validate({"call": "NOTACALL"})


def test_sql_inlines_only_validated_values():
    sql = build_query(validate({"call": "KN0BLE", "band": "14", "role": "rx", "grid": "el98", "hours": "6"}))
    assert "rx_sign = 'KN0BLE'" in sql and "startsWith(rx_loc, 'EL98')" in sql
    assert "band = 14" in sql and "toIntervalHour(6)" in sql and "LIMIT 2000" in sql
    assert "{" not in sql  # no leftover parameter placeholders


@pytest.mark.parametrize("bad", [
    {"call": "KN0BLE' OR 1=1--"}, {"grid": "EL98'"}, {"role": "tx_sign"}, {"band": 13},
])
def test_build_query_rejects_unvalidated(bad):
    spec = {"call": "KN0BLE", "grid": "", "role": "tx", "band": "all", "hours": 24, "limit": 10}
    spec.update(bad)
    with pytest.raises(ValidationError):
        build_query(spec)


def test_str_escapes():
    from wspr.client import _str
    assert _str("a'b\\c") == "'a\\'b\\\\c'"


def test_carto_key_passthrough(c, monkeypatch):
    assert b'data-carto-key=""' in c.get("/wspr/").data
    monkeypatch.setenv("WSPR_CARTO_KEY", 'abc"<x')
    assert b'data-carto-key="abc&#34;&lt;x"' in c.get("/wspr/").data
