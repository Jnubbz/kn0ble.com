# GitHub Pages still publishes this repo from main. This image is the
# same site for Unraid, reached by cloudflared on port 8080.
# nginxinc/nginx-unprivileged runs as uid 101 and already listens on 8080.
FROM nginxinc/nginx-unprivileged:1.30-alpine

USER root

RUN rm -rf /usr/share/nginx/html/*

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY *.html *.txt *.xml *.svg *.png /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY images/ /usr/share/nginx/html/images/

# curl is in this base image; the healthcheck uses it.
RUN chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d/default.conf \
    && command -v curl >/dev/null

# nginx -t as root leaves /tmp/nginx.pid owned by root, and the
# unprivileged process cannot replace it. Test as the runtime user.
USER nginx
RUN nginx -t && rm -f /tmp/nginx.pid

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["curl", "-fsS", "http://127.0.0.1:8080/healthz"]
