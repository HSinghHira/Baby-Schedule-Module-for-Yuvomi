#!/bin/sh
# Starts as root only to make the data folder writable, then runs the service
# as the unprivileged "node" user. A folder that Docker created on the host
# belongs to root, and the service could not write its database there.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" || echo "[baby-schedule] could not change owner of $DATA_DIR; trying anyway"
  exec su-exec node "$@"
fi

exec "$@"
