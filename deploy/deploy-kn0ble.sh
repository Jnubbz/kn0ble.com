#!/bin/bash
# deploy-kn0ble.sh -- update kn0ble.com + WSPR viewer on Unraid.
# Pulls the latest compose file and images, restarts, then checks
# that the site, the WSPR viewer and live wspr.live data all work.
#
# Lives in the Compose Manager project folder on the flash drive
# (/boot can't hold executables, so always run it with bash):
#   bash /boot/config/plugins/compose.manager/projects/kn0ble_com/deploy.sh
#   ... --no-compose   keep your compose file as-is

set -euo pipefail

DIR=/boot/config/plugins/compose.manager/projects/kn0ble_com
# GitHub API, not raw.githubusercontent.com: raw caches ~5 min, so a
# deploy right after a merge could get the old file.
COMPOSE_URL="https://api.github.com/repos/Jnubbz/kn0ble.com/contents/docker-compose.example.yml?ref=main"
CALL=KN0BLE
CF=compose.yaml   # Compose Manager's file name

ok()   { echo -e "\e[32m[ OK ]\e[0m $*"; }
warn() { echo -e "\e[33m[WARN]\e[0m $*"; }
fail() { echo -e "\e[31m[FAIL]\e[0m $*"; exit 1; }

cd "$DIR" || fail "$DIR not found"

# Use the project name Compose Manager started the stack with, so
# compose updates those containers instead of colliding with them.
PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' kn0ble-com 2>/dev/null || true)
PROJECT=${PROJECT:-kn0ble_com}
# No -f: with the stray file gone, compose picks compose.yaml plus any
# compose.override.yaml Compose Manager keeps for its UI labels.
dc() { docker compose -p "$PROJECT" "$@"; }
ok "compose project: $PROJECT"

# 1. Compose file: fetch the one from main, back up yours if it changed.
if [[ "${1:-}" != "--no-compose" ]]; then
  tmp=$(mktemp)
  curl -fsSL -H "Accept: application/vnd.github.raw" "$COMPOSE_URL" -o "$tmp" || fail "could not download compose file"
  if [[ -f $CF ]] && cmp -s "$tmp" "$CF"; then
    ok "compose file already current"
    rm -f "$tmp"
  else
    if [[ -f $CF ]]; then
      bak="$CF.bak-$(date +%Y%m%d-%H%M%S)"
      cp "$CF" "$bak"
      echo "Changes to $CF (old saved as $bak):"
      diff -u "$bak" "$tmp" || true
    fi
    mv "$tmp" "$CF"
    ok "compose file updated"
  fi
fi

# A stray docker-compose.yml beside compose.yaml confuses the plugin.
[[ -f docker-compose.yml ]] && mv docker-compose.yml "docker-compose.yml.unused-$(date +%s)" \
  && warn "moved stray docker-compose.yml aside"

# Network name from the compose file (default qsl-tracker_qsl).
NET=$(awk '/^networks:/{f=1} f && /name:/{print $2; exit}' "$CF")
NET=${NET:-qsl-tracker_qsl}
docker network inspect "$NET" >/dev/null 2>&1 \
  || fail "network $NET missing -- start the qsl-tracker stack first"

# 2. Pull and restart.
dc pull || fail "pull failed -- did the GitHub workflow finish publishing?"
dc up -d
ok "containers started"

# 3. Wait for both healthchecks (up to ~90 s).
for c in kn0ble-com kn0ble-wspr; do
  for _ in $(seq 1 30); do
    s=$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo missing)
    [[ "$s" == healthy ]] && break
    sleep 3
  done
  [[ "$s" == healthy ]] && ok "$c healthy" || fail "$c is $s -- check: docker logs $c"
done

# 4. Check through the site's nginx, the way cloudflared sees it.
get() { docker run --rm --network "$NET" busybox wget -qO- -T 30 "$1" 2>/dev/null; }

[[ "$(get http://kn0ble-com:8080/healthz)" == ok ]] && ok "site /healthz" || fail "site /healthz"
[[ "$(get http://kn0ble-com:8080/wspr/healthz)" == ok ]] && ok "nginx -> /wspr/ proxy" || fail "/wspr/ proxy -- docker logs kn0ble-com"

json=$(get "http://kn0ble-com:8080/wspr/api/spots?call=$CALL&hours=24") || true
if [[ -z "$json" ]]; then
  echo "--- last lines of docker logs kn0ble-wspr ---"
  docker logs --tail 8 kn0ble-wspr 2>&1 || true
  fail "WSPR API returned an error (see log above)"
elif grep -q '"error"' <<<"$json"; then
  fail "WSPR API error: $json"
else
  n=$(grep -o '"tx_sign"' <<<"$json" | wc -l)
  if (( n > 0 )); then
    ok "live wspr.live data: $n spots for $CALL in the last 24 h"
  else
    warn "wspr.live answered but $CALL has 0 spots in 24 h (normal if you haven't beaconed)"
  fi
fi

docker image prune -f >/dev/null && ok "old images pruned"
echo "Done: https://kn0ble.com/wspr/"
