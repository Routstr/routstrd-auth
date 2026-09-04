#!/bin/sh
set -e

# Ensure data directories exist for routstrd and cocod
export ROUTSTRD_DIR="${ROUTSTRD_DIR:-/data/routstrd}"
export COCOD_DIR="${COCOD_DIR:-/data/cocod}"
mkdir -p "$ROUTSTRD_DIR" "$COCOD_DIR" /data/logs

# Attempt to initialize cocod.
# This is idempotent; if already initialized it typically exits non-zero
# with "already initialized", which we safely ignore.
echo "Ensuring cocod wallet is initialized..."
cocod init </dev/null 2>&1 || true

# routstrd stays local to the container. routstrd-auth is the public service.
ROUTSTRD_PORT="${ROUTSTRD_PORT:-${PORT:-8008}}"
ROUTSTRD_AUTH_PORT="${ROUTSTRD_AUTH_PORT:-8080}"
ROUTSTRD_AUTH_HOST="${ROUTSTRD_AUTH_HOST:-0.0.0.0}"
ROUTSTRD_UPSTREAM="${ROUTSTRD_UPSTREAM:-http://localhost:${ROUTSTRD_PORT}}"
# No default admin npub: unset leaves the npubs table empty so the operator
# bootstraps the first admin via unauthenticated POST /npubs (or sets the var).
ROUTSTRD_AUTH_ADMIN_NPUBS="${ROUTSTRD_AUTH_ADMIN_NPUBS:-}"
export ROUTSTRD_AUTH_PORT ROUTSTRD_AUTH_HOST ROUTSTRD_UPSTREAM ROUTSTRD_AUTH_ADMIN_NPUBS

# Ensure routstrd's config.json has authUrl pointing to the auth proxy so the
# CLI routes management commands (npubs, clients, usage) through it.
ROUTSTRD_CONFIG="${ROUTSTRD_DIR}/config.json"
AUTH_URL="http://localhost:${ROUTSTRD_AUTH_PORT}"
echo "Configuring authUrl (${AUTH_URL}) in ${ROUTSTRD_CONFIG}..."
if [ -f "${ROUTSTRD_CONFIG}" ]; then
  bun -e "
    const c = JSON.parse(await Bun.file(process.argv[1]).text());
    c.authUrl = process.argv[2];
    await Bun.write(process.argv[1], JSON.stringify(c, null, 2));
  " "${ROUTSTRD_CONFIG}" "${AUTH_URL}"
else
  echo "{\"authUrl\": \"${AUTH_URL}\"}" > "${ROUTSTRD_CONFIG}"
fi

_term() {
  echo "Shutting down..."
  if [ -n "${AUTH_PID:-}" ]; then
    kill "$AUTH_PID" 2>/dev/null || true
  fi
  routstrd stop 2>/dev/null || true
  wait 2>/dev/null || true
}
trap _term INT TERM

# Start the routstrd daemon first. The CLI daemonizes and exits after starting
# the real daemon, so do not monitor this shell child as the service lifetime.
echo "Starting routstrd daemon on localhost:${ROUTSTRD_PORT}..."
routstrd start --port "$ROUTSTRD_PORT"

# Start routstrd-auth as the public-facing service.
echo "Starting routstrd-auth on ${ROUTSTRD_AUTH_HOST}:${ROUTSTRD_AUTH_PORT}..."
echo "routstrd-auth upstream: ${ROUTSTRD_UPSTREAM}"
bun run /app/src/index.ts start &
AUTH_PID=$!

# Keep PID 1 alive while routstrd-auth is running. Also periodically verify
# that the internal routstrd daemon remains reachable.
while :; do
  if ! kill -0 "$AUTH_PID" 2>/dev/null; then
    echo "routstrd-auth exited."
    wait "$AUTH_PID"
    exit $?
  fi

  if ! bun -e "const r=await fetch('http://localhost:${ROUTSTRD_PORT}/health');process.exit(r.ok?0:1)" >/dev/null 2>&1; then
    echo "routstrd daemon health check failed."
    kill "$AUTH_PID" 2>/dev/null || true
    exit 1
  fi

  sleep 5
done
