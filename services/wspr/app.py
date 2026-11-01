"""WSPR spot viewer for kn0ble.com/wspr/.

Container: gunicorn serves `app:app` on 8000. The site's nginx proxies
/wspr/ here. Locally:

    python app.py                 # live data from wspr.live
    WSPR_MOCK=1 python app.py     # fake data, no network
    open http://127.0.0.1:8000/wspr/
"""
from flask import Flask, redirect

from wspr import wspr_bp

app = Flask(__name__)
app.register_blueprint(wspr_bp)


@app.get("/")
def root():
    return redirect("/wspr/")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, threaded=True)
