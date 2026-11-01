# WSPR spot viewer. The kn0ble-com nginx proxies /wspr/ to this
# container on the qsl network, port 8000. No host ports.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && useradd --system --uid 10001 --no-create-home wspr

COPY app.py .
COPY wspr/ wspr/

USER wspr
EXPOSE 8000

# One worker, several threads: the spot cache and the wspr.live rate
# limit live in process memory, so one process keeps them shared.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "8", \
     "--timeout", "60", "--access-logfile", "-", "app:app"]

# slim has no curl; use Python for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/wspr/healthz', timeout=4)"]
