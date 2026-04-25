#!/bin/sh
set -e

# Ensure data directories exist for routstrd and cocod
mkdir -p /data/.cocod
mkdir -p /data/logs

# Attempt to initialize cocod.
# This is idempotent; if already initialized it typically exits non-zero
# with "already initialized", which we safely ignore.
echo "Ensuring cocod wallet is initialized..."
cocod init </dev/null 2>&1 || true

# Build the start command
if [ -n "$PORT" ]; then
  set -- routstrd start --port "$PORT"
else
  set -- routstrd start
fi

echo "Starting daemon..."
"$@" &

# Wait for the daemon to be ready, then stay alive as PID 1
WAIT=0
while [ $WAIT -lt 30 ]; do
  if curl -sf http://localhost:${PORT:-8008}/health > /dev/null 2>&1; then
    echo "Daemon is ready."
    break
  fi
  WAIT=$((WAIT + 1))
  sleep 1
done

if [ $WAIT -ge 30 ]; then
  echo "Daemon is taking longer than expected, please wait..."
  echo "Tip: run 'cocod logs --follow' or 'tail -n 40 ~/.cocod/daemon.log' in another terminal."
fi

# Keep the entrypoint alive so the container doesn't restart.
# The shell stays alive as PID 1, acting as the init process.
tail -f /dev/null
