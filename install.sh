#!/bin/sh
# Baby Schedule for Yuvomi - install or update with one command.
#
#   curl -fsSL https://raw.githubusercontent.com/HSinghHira/Baby-Schedule-Module-for-Yuvomi/main/install.sh | sh
#
# or, from a copy of this repository on the server:   sh install.sh
#
# What it does (run it again any time to update; your schedule is kept):
#   1. finds your running Yuvomi container, its port and its modules folder
#   2. builds and starts the Baby Schedule service (its own small database)
#   3. copies the Baby Schedule module into Yuvomi and restarts Yuvomi
#   4. tells you the one route to add in your proxy (Cloudflare Tunnel, Nginx
#      Proxy Manager, ...) and waits until it works
#
# Optional settings (environment variables):
#   BS_DOMAIN=https://home.example.com   the address you open Yuvomi at
#   BS_PORT=6540                         port for the service on this server
#   BS_DATA=/path/to/data                where the schedule database is kept
#   BS_GATEWAY=1                         no proxy in front of Yuvomi? start a small
#                                        gateway and open Yuvomi through it instead
#   YUVOMI_CONTAINER=yuvomi              if the Yuvomi container is not found
#   BS_REPO=owner/repo  BS_BRANCH=main   where to download from

set -eu

REPO="${BS_REPO:-HSinghHira/Baby-Schedule-Module-for-Yuvomi}"
BRANCH="${BS_BRANCH:-main}"
NAME="baby-schedule"
GATEWAY_NAME="baby-schedule-gateway"
IMAGE="baby-schedule-sidecar:latest"
PREFIX="/api/extensions/baby-schedule"

if [ -t 1 ]; then B="$(printf '\033[1m')"; G="$(printf '\033[32m')"; Y="$(printf '\033[33m')"; R="$(printf '\033[31m')"; N="$(printf '\033[0m')"; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# Read an answer from the keyboard even when the script comes through a pipe.
ask() {
  REPLY=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s' "$1" > /dev/tty
    read -r REPLY < /dev/tty || REPLY=""
  fi
}

inspect() { docker inspect -f "$2" "$1" 2>/dev/null || true; }

port_in_use() {
  { ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || true; } | awk '{print $4}' | grep -Eq "[:.]$1\$"
}

lan_ip() {
  addr=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  [ -n "$addr" ] || addr=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "${addr:-<this-server-ip>}"
}

wait_for() { # wait_for <seconds> <command...>
  limit=$1; shift
  i=0
  while [ "$i" -lt "$limit" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

sidecar_healthy() {
  docker exec "$NAME" node -e "fetch('http://127.0.0.1:8080$PREFIX/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

sidecar_sees_yuvomi() {
  docker exec "$NAME" node -e "fetch(process.env.YUVOMI_INTERNAL_URL+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

yuvomi_healthy() {
  state=$(inspect "$YC" '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
  [ "$state" = "healthy" ] || [ "$state" = "running" ]
}

route_works() {
  out=$(curl -fsS --max-time 8 "$DOMAIN$PREFIX/health" 2>/dev/null || wget -qO- -T 8 "$DOMAIN$PREFIX/health" 2>/dev/null || true)
  printf '%s' "$out" | grep -q '"ok":true'
}

# ---------------------------------------------------------------------------
step "Checking Docker"
command -v docker >/dev/null 2>&1 || die "Docker is not installed on this machine."
docker info >/dev/null 2>&1 || die "Cannot talk to Docker. Run this as root (for example: sudo sh install.sh)."
ok "Docker is ready"

# ---------------------------------------------------------------------------
step "Finding Yuvomi"
YC="${YUVOMI_CONTAINER:-}"
if [ -z "$YC" ]; then
  YC=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /yuvomi|oikos/ && tolower($1) !~ /baby-schedule/ {print $1; exit}')
fi
[ -n "$YC" ] || die "No running Yuvomi container found. Start Yuvomi first, or run with YUVOMI_CONTAINER=<its name>."
ok "Yuvomi container: $YC"

MODDIR=$(inspect "$YC" '{{range .Mounts}}{{if eq .Destination "/app/modules"}}{{.Source}}{{end}}{{end}}')
[ -n "$MODDIR" ] && [ -d "$MODDIR" ] || die "Yuvomi has no modules folder (/app/modules) on this server, so modules cannot be installed. Add a volume for /app/modules to your Yuvomi app (Umbrel does not support this)."
ok "Modules folder: $MODDIR"

# How the service reaches Yuvomi: by name on a shared Docker network, or
# through the port Yuvomi publishes on this machine.
NETMODE=$(inspect "$YC" '{{.HostConfig.NetworkMode}}')
YPORT=$(docker port "$YC" 3000/tcp 2>/dev/null | head -n 1 | sed 's/.*://')
NETARGS=""
if [ "$NETMODE" = "host" ]; then
  YPORT=$(inspect "$YC" '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PORT=//p' | head -n 1)
  YPORT="${YPORT:-3000}"
  YUVOMI_URL="http://host.docker.internal:$YPORT"
elif [ -n "$NETMODE" ] && [ "$NETMODE" != "bridge" ] && [ "$NETMODE" != "default" ] && [ "${NETMODE#container:}" = "$NETMODE" ]; then
  NETARGS="--network $NETMODE"
  YUVOMI_URL="http://$YC:3000"
elif [ -n "$YPORT" ]; then
  YUVOMI_URL="http://host.docker.internal:$YPORT"
else
  die "Could not find how to reach Yuvomi (no published port). Publish Yuvomi's port 3000, or run with YUVOMI_CONTAINER set."
fi
ok "The service will reach Yuvomi at $YUVOMI_URL"

# ---------------------------------------------------------------------------
step "Getting Baby Schedule"
SRC=""
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "$HERE" ] && [ -f "$HERE/sidecar/Dockerfile" ] && [ -f "$HERE/modules/baby-schedule/module.json" ]; then
  SRC="$HERE"
  ok "Using the files next to this script ($SRC)"
else
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" | tar -xz -C "$TMP" || die "Download failed: $URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$URL" | tar -xz -C "$TMP" || die "Download failed: $URL"
  else
    die "Neither curl nor wget is available to download Baby Schedule."
  fi
  SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -f "$SRC/sidecar/Dockerfile" ] || die "The download does not look like Baby Schedule ($URL)."
  ok "Downloaded $REPO ($BRANCH)"
fi
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/modules/baby-schedule/module.json" | head -n 1)

# ---------------------------------------------------------------------------
step "Building the Baby Schedule service (first time takes a minute)"
docker build -q -t "$IMAGE" "$SRC/sidecar" >/dev/null || die "Building the service failed. Run: docker build -t $IMAGE $SRC/sidecar   to see why."
ok "Built $IMAGE"

# Keep what an earlier install chose: data folder, port, address.
OLD_DATA=$(inspect "$NAME" '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
OLD_PORT=$(docker port "$NAME" 8080/tcp 2>/dev/null | head -n 1 | sed 's/.*://' || true)
OLD_ORIGINS=$(inspect "$NAME" '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ALLOWED_ORIGINS=//p' | head -n 1)

if [ -n "${BS_DATA:-}" ]; then DATA="$BS_DATA"
elif [ -n "$OLD_DATA" ]; then DATA="$OLD_DATA"
elif [ -d /DATA/AppData ]; then DATA="/DATA/AppData/baby-schedule/data"
else DATA="/opt/baby-schedule/data"
fi
mkdir -p "$DATA"
chown -R 1000:1000 "$DATA" 2>/dev/null || true

if [ -n "${BS_PORT:-}" ]; then PORT="$BS_PORT"
elif [ -n "$OLD_PORT" ]; then PORT="$OLD_PORT"
else
  PORT=6540
  while port_in_use "$PORT"; do PORT=$((PORT + 1)); done
fi

DOMAIN="${BS_DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -n "$OLD_ORIGINS" ]; then DOMAIN="${OLD_ORIGINS%%,*}"; fi
if [ -z "$DOMAIN" ]; then
  ask "  Which web address do you open Yuvomi at? (e.g. https://home.example.com, Enter to skip): "
  DOMAIN="$REPLY"
fi
DOMAIN=$(printf '%s' "$DOMAIN" | tr -d ' ' | sed 's#/*$##')
case "$DOMAIN" in
  "") ;;
  http://*|https://*) ;;
  *) DOMAIN="https://$DOMAIN" ;;
esac

step "Starting the Baby Schedule service"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run -d --name "$NAME" --restart unless-stopped \
  -p "$PORT:8080" $NETARGS \
  --add-host host.docker.internal:host-gateway \
  -e "YUVOMI_INTERNAL_URL=$YUVOMI_URL" \
  -e "ALLOWED_ORIGINS=$DOMAIN" \
  -e "TRUST_PROXY_HOPS=1" \
  -v "$DATA:/data" \
  "$IMAGE" >/dev/null || die "The service did not start. See: docker logs $NAME"

if wait_for 40 sidecar_healthy; then
  ok "Service running on port $PORT (data in $DATA)"
else
  docker logs --tail 20 "$NAME" 2>&1 | sed 's/^/    /'
  die "The service did not come up. The lines above say why."
fi
if wait_for 10 sidecar_sees_yuvomi; then
  ok "The service can reach Yuvomi"
else
  warn "The service cannot reach Yuvomi at $YUVOMI_URL yet. Sign-ins will fail until it can."
fi

# ---------------------------------------------------------------------------
step "Installing the module into Yuvomi"
OWNER=$(stat -c '%u:%g' "$MODDIR" 2>/dev/null || echo "")
rm -rf "$MODDIR/baby-schedule"
cp -R "$SRC/modules/baby-schedule" "$MODDIR/baby-schedule"
[ -n "$OWNER" ] && chown -R "$OWNER" "$MODDIR/baby-schedule" 2>/dev/null || true
ok "Copied Baby Schedule ${VERSION:+$VERSION }to $MODDIR/baby-schedule"

docker restart "$YC" >/dev/null || die "Could not restart $YC."
if wait_for 120 yuvomi_healthy; then ok "Yuvomi restarted"; else warn "Yuvomi is taking long to start; check it with: docker ps"; fi

# ---------------------------------------------------------------------------
# Optional gateway for setups without a reverse proxy.
if [ "${BS_GATEWAY:-0}" = "1" ]; then
  step "Starting the gateway"
  GW_DIR="$(dirname "$DATA")/gateway"
  mkdir -p "$GW_DIR"
  cp "$SRC/deploy/nginx/default.conf.template" "$GW_DIR/default.conf.template"
  OLD_GW=$(docker port "$GATEWAY_NAME" 80/tcp 2>/dev/null | head -n 1 | sed 's/.*://' || true)
  GW_PORT="${BS_GATEWAY_PORT:-${OLD_GW:-$((PORT + 1))}}"
  [ -n "$OLD_GW" ] || while port_in_use "$GW_PORT"; do GW_PORT=$((GW_PORT + 1)); done
  YUP="$YUVOMI_URL"; [ -n "$NETARGS" ] || YUP="http://host.docker.internal:$YPORT"
  docker rm -f "$GATEWAY_NAME" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker run -d --name "$GATEWAY_NAME" --restart unless-stopped -p "$GW_PORT:80" $NETARGS \
    --add-host host.docker.internal:host-gateway \
    -e "YUVOMI_UPSTREAM=$YUP" -e "SIDECAR_UPSTREAM=http://host.docker.internal:$PORT" \
    -e 'NGINX_ENVSUBST_FILTER=^(YUVOMI_UPSTREAM|SIDECAR_UPSTREAM)$' \
    -v "$GW_DIR/default.conf.template:/etc/nginx/templates/default.conf.template:ro" \
    nginx:1.27-alpine >/dev/null || die "The gateway did not start. See: docker logs $GATEWAY_NAME"
  ok "Gateway on port $GW_PORT"
  printf '\n  %sFrom now on open Yuvomi at http://%s:%s%s (instead of port %s).\n' "$B" "$(lan_ip)" "$GW_PORT" "$N" "${YPORT:-3000}"
  printf '  If a proxy or Cloudflare Tunnel serves Yuvomi, point it at port %s instead of %s.\n' "$GW_PORT" "${YPORT:-3000}"
fi

# ---------------------------------------------------------------------------
if [ "${BS_GATEWAY:-0}" != "1" ]; then
  step "One route in your proxy"
  if [ -n "$DOMAIN" ] && route_works; then
    ok "$DOMAIN$PREFIX/ already reaches the service. Nothing to do."
  else
    CF=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /cloudflared|cloudflare\/cloudflared/ {print $1; exit}')
    NPM=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /nginx-proxy-manager/ {print $1; exit}')
    HOST_SHOWN=$(printf '%s' "${DOMAIN:-https://your-yuvomi-address}" | sed 's#^https\{0,1\}://##')
    printf '\n  Requests to %s/api/extensions/baby-schedule/ must go to this service\n' "$HOST_SHOWN"
    printf '  instead of Yuvomi. Everything else stays as it is.\n\n'
    if [ -n "$CF" ]; then
      if [ "$(inspect "$CF" '{{.HostConfig.NetworkMode}}')" = "host" ]; then SVC="localhost:$PORT"; else SVC="$(lan_ip):$PORT"; fi
      printf '  %sCloudflare Tunnel%s (found container "%s"):\n' "$B" "$N" "$CF"
      printf '    1. dash.cloudflare.com -> Zero Trust -> Networks -> Tunnels -> your tunnel\n'
      printf '    2. Published application routes -> Add a published application route\n'
      printf '         Subdomain + Domain:  %s\n' "$HOST_SHOWN"
      printf '         Path:                %sapi/extensions/baby-schedule%s\n' "$B" "$N"
      printf '         Service:             HTTP   %s%s%s\n' "$B" "$SVC" "$N"
      printf '    3. Save, and make sure this route is listed ABOVE the plain %s route.\n' "$HOST_SHOWN"
    elif [ -n "$NPM" ]; then
      printf '  %sNginx Proxy Manager%s: Proxy Hosts -> %s -> Edit -> Advanced, paste:\n\n' "$B" "$N" "$HOST_SHOWN"
      printf '    location ^~ /api/extensions/baby-schedule/ {\n'
      printf '        proxy_pass http://%s:%s;\n' "$(lan_ip)" "$PORT"
      printf '        proxy_set_header Host $host;\n'
      printf '        proxy_set_header X-Forwarded-Host $host;\n'
      printf '        proxy_set_header X-Forwarded-Proto $scheme;\n'
      printf '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
      printf '    }\n'
    else
      printf '  In your reverse proxy, send the path /api/extensions/baby-schedule/\n'
      printf '  to http://%s:%s (Traefik, Caddy, nginx examples: README.md).\n' "$(lan_ip)" "$PORT"
      printf '  No proxy at all (Yuvomi opened as http://server:port)? Run again with BS_GATEWAY=1.\n'
    fi

    if [ -n "$DOMAIN" ]; then
      printf '\n  Waiting until %s%s/health answers (add the route now; Ctrl+C to stop waiting)' "$DOMAIN" "$PREFIX"
      tries=$(( ${BS_WAIT:-900} / 5 ))
      i=0
      while [ "$i" -lt "$tries" ]; do
        if route_works; then printf '\n'; ok "The route works"; break; fi
        printf '.'; sleep 5; i=$((i + 1))
      done
      [ "$i" -lt "$tries" ] || { printf '\n'; warn "Not working yet. Run this script again after adding the route; it will check again."; }
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "Done"
printf '  Open Yuvomi -> %sBaby Schedule%s in the menu.\n' "$B" "$N"
printf '  On the home screen, the %sBaby today%s widget can be switched on under Customize.\n' "$B" "$N"
printf '  For the baby'"'"'s next activity in "Today at a glance" and Wall Mode:\n'
printf '    Settings -> Modules -> Baby Schedule -> %sTurn on%s (admin, once).\n' "$B" "$N"
printf '\n  Update later by running the same command again. Your schedule stays in %s.\n\n' "$DATA"
