# Stream relay for kn0ble.com/tv. kn0ble-com's nginx proxies /tv/live/
# to this container on the qsl network, port 8000. No host ports.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10002 --no-create-home tv

WORKDIR /app
COPY tvproxy.py .

USER tv
EXPOSE 8000
CMD ["python", "tvproxy.py"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"]
