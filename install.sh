#!/bin/sh
# Baby Schedule for Yuvomi - install, update or remove with one command.
#
#   curl -fsSL https://cdn.jsdelivr.net/gh/HSinghHira/Baby-Schedule-Module-for-Yuvomi@main/install.sh | sh
#
# or, from a copy of this repository on the server:   sh install.sh
#
# It installs the newest published release (a fixed, tagged version), not
# whatever the main branch holds at that moment. Before changing anything it
# lists what it will do and asks to continue.
#
# What it does (run it again any time to update; your schedule is kept):
#   1. finds your running Yuvomi container, its port and its modules folder
#   2. builds and starts the Baby Schedule service (its own small database)
#   3. copies the Baby Schedule module into Yuvomi and restarts Yuvomi
#      (skipped when the module did not change)
#   4. tells you the one route to add in your proxy (Cloudflare Tunnel, Nginx
#      Proxy Manager, ...) and waits until it works
#
# It needs root (or Docker access), because it builds and runs containers and
# writes into Yuvomi's modules folder.
#
# Optional settings (environment variables):
#   BS_VERSION=v1.2.0                    install this release (default: the newest)
#   BS_DOMAIN=https://home.example.com   the address you open Yuvomi at
#   BS_PORT=6540                         port for the service on this server
#   BS_DATA=/path/to/data                where the schedule database is kept
#   BS_GATEWAY=1                         no proxy in front of Yuvomi? start a small
#                                        gateway and open Yuvomi through it instead
#                                        (kept on updates; BS_GATEWAY=0 removes it)
#   BS_GATEWAY_PORT=6541                 port for that gateway
#   BS_YES=1                             do not ask before making changes
#   BS_UNINSTALL=1                       remove Baby Schedule (the schedule data is kept)
#   YUVOMI_CONTAINER=yuvomi              if the Yuvomi container is not found
#   BS_REPO=owner/repo                   where to download from
#   BS_BRANCH=main                       install a branch instead of a release
#                                        (for testing; not a fixed version)

set -eu

REPO="${BS_REPO:-HSinghHira/Baby-Schedule-Module-for-Yuvomi}"
NAME="baby-schedule"
GATEWAY_NAME="baby-schedule-gateway"
IMAGE_REPO="baby-schedule-sidecar"
PREFIX="/api/extensions/baby-schedule"
SOURCE_LABEL="io.github.hsinghhira.baby-schedule.source"

if [ -t 1 ]; then B="$(printf '\033[1m')"; G="$(printf '\033[32m')"; Y="$(printf '\033[33m')"; R="$(printf '\033[31m')"; N="$(printf '\033[0m')"; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
item() { printf '    - %s\n' "$*"; }
die()  { printf '\n%sError:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# Read an answer from the keyboard even when the script comes through a pipe.
ask() {
  REPLY=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s' "$1" > /dev/tty
    read -r REPLY < /dev/tty || REPLY=""
  fi
}

# Ask before changing anything. No keyboard (automation) or BS_YES=1: go ahead.
confirm() {
  [ "${BS_YES:-0}" = "1" ] && return 0
  ask "  $1 [Y/n] "
  case "$REPLY" in
    n|N|no|NO|No) printf '  Nothing was changed.\n\n'; exit 0 ;;
  esac
}

inspect() { docker inspect -f "$2" "$1" 2>/dev/null || true; }
exists()  { docker inspect "$1" >/dev/null 2>&1; }

fetch() { # fetch <url>: print the body, or nothing
  curl -fsSL --max-time 20 "$1" 2>/dev/null || wget -qO- -T 20 "$1" 2>/dev/null || true
}

latest_release() {
  fetch "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1
}

module_version() { # module_version <module folder>
  [ -f "$1/module.json" ] || return 0
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/module.json" | head -n 1
}

ver_lt() { # ver_lt 1.2.0 1.10.0 -> true
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, "."); k = n > m ? n : m
    for (i = 1; i <= k; i++) { if (x[i] + 0 < y[i] + 0) exit 0; if (x[i] + 0 > y[i] + 0) exit 1 }
    exit 1 }'
}

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

# True when the module in Yuvomi already matches the one being installed.
# Without diff, assume it changed (copying again is always safe).
module_unchanged() {
  [ -d "$MODDIR/baby-schedule" ] && command -v diff >/dev/null 2>&1 \
    && diff -r -q "$SRC/modules/baby-schedule" "$MODDIR/baby-schedule" >/dev/null 2>&1
}

run_sidecar() { # run_sidecar <image>
  # shellcheck disable=SC2086
  docker run -d --name "$NAME" --restart unless-stopped \
    -p "$PORT:8080" $NETARGS \
    --add-host host.docker.internal:host-gateway \
    --label "$SOURCE_LABEL=$SOURCE" \
    -e "YUVOMI_INTERNAL_URL=$YUVOMI_URL" \
    -e "ALLOWED_ORIGINS=$DOMAIN" \
    -e "TRUST_PROXY_HOPS=1" \
    -v "$DATA:/data" \
    "$1" >/dev/null
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

OLD_VERSION=$(module_version "$MODDIR/baby-schedule")
OLD_DATA=$(inspect "$NAME" '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')

# ---------------------------------------------------------------------------
if [ "${BS_UNINSTALL:-0}" = "1" ]; then
  step "Removing Baby Schedule"
  printf '  This will:\n'
  exists "$NAME" && item "remove the container \"$NAME\""
  exists "$GATEWAY_NAME" && item "remove the container \"$GATEWAY_NAME\" (open Yuvomi on its own port again)"
  item "remove the $IMAGE_REPO images"
  [ -d "$MODDIR/baby-schedule" ] && item "remove $MODDIR/baby-schedule ${OLD_VERSION:+(version $OLD_VERSION) }and restart \"$YC\""
  item "keep the schedule data${OLD_DATA:+ in $OLD_DATA}"
  confirm "Remove Baby Schedule?"

  HAD_GATEWAY=0; exists "$GATEWAY_NAME" && HAD_GATEWAY=1
  docker rm -f "$NAME" "$GATEWAY_NAME" >/dev/null 2>&1 || true
  for img in $(docker images --format '{{.Repository}}:{{.Tag}}' "$IMAGE_REPO" 2>/dev/null); do
    docker rmi "$img" >/dev/null 2>&1 || true
  done
  ok "Service removed"
  if [ -d "$MODDIR/baby-schedule" ]; then
    rm -rf "$MODDIR/baby-schedule"
    docker restart "$YC" >/dev/null || die "Could not restart $YC."
    ok "Module removed from Yuvomi"
  fi

  step "Done"
  [ -n "$OLD_DATA" ] && printf '  The schedule is still in %s. Delete that folder if you no longer need it.\n' "$OLD_DATA"
  printf '  Remove the /api/extensions/baby-schedule route from your proxy, if you added one.\n'
  [ "$HAD_GATEWAY" = "1" ] && printf '  The gateway is gone: open Yuvomi on its own port again, and point any proxy back at it.\n'
  printf '\n'
  exit 0
fi

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
TAG=""
BRANCH=""
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -z "${BS_VERSION:-}" ] && [ -z "${BS_BRANCH:-}" ] && [ -n "$HERE" ] \
   && [ -f "$HERE/sidecar/Dockerfile" ] && [ -f "$HERE/modules/baby-schedule/module.json" ]; then
  SRC="$HERE"
  SOURCE="local copy"
  ok "Using the files next to this script ($SRC)"
else
  if [ -n "${BS_VERSION:-}" ]; then
    TAG="$BS_VERSION"
    case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac
  elif [ -n "${BS_BRANCH:-}" ]; then
    BRANCH="$BS_BRANCH"
  else
    TAG=$(latest_release)
    if [ -z "$TAG" ]; then
      BRANCH="main"
      warn "No release found (or GitHub could not be reached), so this installs the main branch."
    fi
  fi
  if [ -n "$TAG" ]; then
    URL="https://codeload.github.com/$REPO/tar.gz/refs/tags/$TAG"; SOURCE="release $TAG"
  else
    URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"; SOURCE="branch $BRANCH"
  fi
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
    || die "Neither curl nor wget is available to download Baby Schedule."
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  { curl -fsSL "$URL" 2>/dev/null || wget -qO- "$URL" 2>/dev/null; } | tar -xz -C "$TMP" 2>/dev/null \
    || die "Download failed: $URL${TAG:+ (is $TAG a published release?)}"
  SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -n "$SRC" ] && [ -f "$SRC/sidecar/Dockerfile" ] || die "The download does not look like Baby Schedule ($URL)."
  ok "Downloaded $REPO ($SOURCE)"
fi

VERSION=$(module_version "$SRC/modules/baby-schedule")
[ -n "$VERSION" ] || die "Could not read the version from $SRC/modules/baby-schedule/module.json."
if [ -n "$TAG" ] && [ "$TAG" != "v$VERSION" ]; then
  warn "Release $TAG contains module version $VERSION. The release may be mislabeled."
fi
# The image tag names the version, so the installed version is visible in
# "docker ps" and an older image is never mistaken for the new one.
case "$SOURCE" in
  release*) IMAGE="$IMAGE_REPO:$VERSION" ;;
  branch*)  IMAGE="$IMAGE_REPO:$VERSION-dev" ;;
  *)        IMAGE="$IMAGE_REPO:$VERSION-local" ;;
esac

# ---------------------------------------------------------------------------
# Keep what an earlier install chose: data folder, port, address, gateway.
OLD_IMAGE=$(inspect "$NAME" '{{.Config.Image}}')
OLD_SOURCE=$(inspect "$NAME" "{{index .Config.Labels \"$SOURCE_LABEL\"}}")
OLD_PORT=$(docker port "$NAME" 8080/tcp 2>/dev/null | head -n 1 | sed 's/.*://' || true)
OLD_ORIGINS=$(inspect "$NAME" '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ALLOWED_ORIGINS=//p' | head -n 1)

if [ -n "${BS_DATA:-}" ]; then DATA="$BS_DATA"
elif [ -n "$OLD_DATA" ]; then DATA="$OLD_DATA"
elif [ -d /DATA/AppData ]; then DATA="/DATA/AppData/baby-schedule/data"
else DATA="/opt/baby-schedule/data"
fi

if [ -n "${BS_PORT:-}" ]; then PORT="$BS_PORT"
elif [ -n "$OLD_PORT" ]; then PORT="$OLD_PORT"
else
  PORT=6540
  while port_in_use "$PORT"; do PORT=$((PORT + 1)); done
fi

# A gateway from an earlier install stays unless BS_GATEWAY=0 is given.
GATEWAY="${BS_GATEWAY:-}"
if [ -z "$GATEWAY" ]; then
  if exists "$GATEWAY_NAME"; then GATEWAY=1; else GATEWAY=0; fi
fi
REMOVE_GATEWAY=0
[ "$GATEWAY" != "1" ] && exists "$GATEWAY_NAME" && REMOVE_GATEWAY=1

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

MODULE_CHANGED=1
module_unchanged && MODULE_CHANGED=0

# ---------------------------------------------------------------------------
step "What will change"
if [ -z "$OLD_VERSION" ]; then
  printf '  Installing Baby Schedule %s%s%s (%s).\n' "$B" "$VERSION" "$N" "$SOURCE"
elif [ "$OLD_VERSION" = "$VERSION" ]; then
  printf '  Baby Schedule %s is installed%s. Reinstalling %s (%s).\n' "$OLD_VERSION" "${OLD_SOURCE:+ ($OLD_SOURCE)}" "$VERSION" "$SOURCE"
else
  printf '  Updating Baby Schedule %s -> %s%s%s (%s).\n' "$OLD_VERSION" "$B" "$VERSION" "$N" "$SOURCE"
  if ver_lt "$VERSION" "$OLD_VERSION"; then
    warn "This is an OLDER version than the one installed. Its database may not know newer changes."
    warn "Copy $DATA somewhere safe before you continue."
  fi
fi
printf '\n  This will:\n'
item "build the Docker image $IMAGE"
item "$(if exists "$NAME"; then printf 'replace'; else printf 'start'; fi) the container \"$NAME\" on port $PORT (schedule data in $DATA, kept)"
if [ "$MODULE_CHANGED" = "1" ]; then
  item "copy the module into $MODDIR/baby-schedule and restart the Yuvomi container \"$YC\""
else
  item "leave the module in Yuvomi as it is (unchanged), so Yuvomi is not restarted"
fi
if [ "$GATEWAY" = "1" ]; then
  item "$(if exists "$GATEWAY_NAME"; then printf 'replace'; else printf 'start'; fi) the container \"$GATEWAY_NAME\", which sits in front of Yuvomi"
fi
[ "$REMOVE_GATEWAY" = "1" ] && item "remove the container \"$GATEWAY_NAME\" (open Yuvomi on its own port again)"
confirm "Continue?"

# ---------------------------------------------------------------------------
step "Building the Baby Schedule service (first time takes a minute)"
docker build -q -t "$IMAGE" "$SRC/sidecar" >/dev/null || die "Building the service failed. Run: docker build -t $IMAGE $SRC/sidecar   to see why."
ok "Built $IMAGE"

mkdir -p "$DATA"
chown -R 1000:1000 "$DATA" 2>/dev/null || true

step "Starting the Baby Schedule service"
docker rm -f "$NAME" >/dev/null 2>&1 || true
run_sidecar "$IMAGE" || die "The service did not start. See: docker logs $NAME"

if wait_for 40 sidecar_healthy; then
  ok "Service running on port $PORT (data in $DATA)"
else
  docker logs --tail 20 "$NAME" 2>&1 | sed 's/^/    /'
  # Go back to the version that was running before, so the family keeps a
  # working schedule while the problem is looked at.
  if [ -n "$OLD_IMAGE" ] && [ "$OLD_IMAGE" != "$IMAGE" ] && docker image inspect "$OLD_IMAGE" >/dev/null 2>&1; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    SOURCE="$OLD_SOURCE"
    if run_sidecar "$OLD_IMAGE" && wait_for 40 sidecar_healthy; then
      die "Version $VERSION did not come up (lines above), so the previous version ($OLD_IMAGE) is running again. Nothing else was changed."
    fi
  fi
  die "The service did not come up. The lines above say why."
fi
if wait_for 10 sidecar_sees_yuvomi; then
  ok "The service can reach Yuvomi"
else
  warn "The service cannot reach Yuvomi at $YUVOMI_URL yet. Sign-ins will fail until it can."
fi

# Remove images of other versions, now that this one works.
for old in $(docker images --format '{{.Tag}}' "$IMAGE_REPO" 2>/dev/null); do
  [ "$old" = "<none>" ] || [ "$IMAGE_REPO:$old" = "$IMAGE" ] || docker rmi "$IMAGE_REPO:$old" >/dev/null 2>&1 || true
done

# ---------------------------------------------------------------------------
step "Installing the module into Yuvomi"
if [ "$MODULE_CHANGED" = "1" ]; then
  OWNER=$(stat -c '%u:%g' "$MODDIR" 2>/dev/null || echo "")
  rm -rf "$MODDIR/baby-schedule"
  cp -R "$SRC/modules/baby-schedule" "$MODDIR/baby-schedule"
  [ -n "$OWNER" ] && chown -R "$OWNER" "$MODDIR/baby-schedule" 2>/dev/null || true
  ok "Copied Baby Schedule $VERSION to $MODDIR/baby-schedule"

  docker restart "$YC" >/dev/null || die "Could not restart $YC."
  if wait_for 120 yuvomi_healthy; then ok "Yuvomi restarted"; else warn "Yuvomi is taking long to start; check it with: docker ps"; fi
else
  ok "The module is already up to date; Yuvomi was not restarted"
fi

# ---------------------------------------------------------------------------
# Optional gateway for setups without a reverse proxy.
if [ "$REMOVE_GATEWAY" = "1" ]; then
  step "Removing the gateway"
  docker rm -f "$GATEWAY_NAME" >/dev/null 2>&1 || true
  ok "Gateway removed"
  printf '  Open Yuvomi on its own port (%s) again, and point any proxy back at it.\n' "${YPORT:-3000}"
fi

if [ "$GATEWAY" = "1" ]; then
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
if [ "$GATEWAY" != "1" ]; then
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
printf '  Baby Schedule %s%s%s is installed (%s).\n\n' "$B" "$VERSION" "$N" "$SOURCE"
printf '  Open Yuvomi -> %sBaby Schedule%s in the menu.\n' "$B" "$N"
printf '  On the home screen, the %sBaby today%s widget can be switched on under Customize.\n' "$B" "$N"
printf '  For the baby'"'"'s next activity in "Today at a glance" and Wall Mode:\n'
printf '    Settings -> Modules -> Baby Schedule -> %sTurn on%s (admin, once).\n' "$B" "$N"
printf '\n  Run the same command again to update to the newest release; your schedule stays in %s.\n' "$DATA"
printf '  Updates come only from this script: Yuvomi'"'"'s Settings cannot update a module installed this way.\n\n'
