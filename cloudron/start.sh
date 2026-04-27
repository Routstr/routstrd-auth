#!/bin/bash
set -eu

echo "==> Preparing persistent data directory..."
mkdir -p /app/data/cocod /app/data/logs
chown -R cloudron:cloudron /app/data

# Make Cloudron defaults visible to every child process. Users can still
# override these through Cloudron environment variables if needed.
export HOME="/app/data"
export ROUTSTRD_DIR="${ROUTSTRD_DIR:-/app/data/routstrd}"
export COCOD_DIR="${COCOD_DIR:-/app/data/cocod}"
export ROUTSTRD_AUTH_HOST="${ROUTSTRD_AUTH_HOST:-0.0.0.0}"
export ROUTSTRD_AUTH_PORT="${ROUTSTRD_AUTH_PORT:-8008}"
export ROUTSTRD_PORT="${ROUTSTRD_PORT:-8009}"
export ROUTSTRD_UPSTREAM="${ROUTSTRD_UPSTREAM:-http://localhost:${ROUTSTRD_PORT}}"
export ROUTSTRD_DB_PATH="${ROUTSTRD_DB_PATH:-/app/data/routstrd/routstr.db}"

if [[ ! -f /app/data/.initialized ]]; then
    echo "==> First run detected. Initializing wallet/data files..."
    # cocod init is idempotent-ish but may exit non-zero when already initialized.
    # Run it as the same user as the app so generated files are not root-owned.
    gosu cloudron:cloudron env HOME="$HOME" ROUTSTRD_DIR="$ROUTSTRD_DIR" COCOD_DIR="$COCOD_DIR" cocod init </dev/null 2>&1 || true
    touch /app/data/.initialized
    chown -R cloudron:cloudron /app/data
    echo "==> Initialization complete."
fi

echo "==> Starting supervisord..."
exec /usr/bin/supervisord --configuration /etc/supervisor/supervisord-cloudron.conf -i RoutstrdApp
