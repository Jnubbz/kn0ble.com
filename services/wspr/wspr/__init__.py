"""KN0BLE.com WSPR spot viewer blueprint.

Register in your app:
    from wspr import wspr_bp
    app.register_blueprint(wspr_bp)   # serves /wspr/, /wspr/api/spots, /wspr/healthz
"""
from flask import Blueprint, jsonify, render_template, request

from .client import BANDS, UpstreamError, ValidationError, fetch_spots, validate

wspr_bp = Blueprint("wspr", __name__, url_prefix="/wspr",
                    template_folder="templates", static_folder="static",
                    static_url_path="/wspr-static")

DEFAULT_CALL = "KN0BLE"


@wspr_bp.get("/")
def index():
    bands = sorted(BANDS.items())
    return render_template("wspr/index.html", bands=bands, default_call=DEFAULT_CALL)


@wspr_bp.get("/healthz")
def healthz():
    return "ok\n", 200, {"Content-Type": "text/plain"}


@wspr_bp.get("/api/spots")
def api_spots():
    try:
        spec = validate(request.args)
    except ValidationError as e:
        return jsonify(error=str(e)), 400
    try:
        data = fetch_spots(spec)
    except UpstreamError:
        return jsonify(error="wspr.live is unavailable right now; try again shortly."), 502
    resp = jsonify(data)
    resp.headers["Cache-Control"] = "public, max-age=60"
    return resp
