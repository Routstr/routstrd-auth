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

# Runtime IPC files live under /app/data/cocod, which is persistent on
# Cloudron/bind-mounted installs. After a container restart they can point at a
# dead socket or a recycled PID, causing cocod to incorrectly report
# "already_running" while routstrd cannot connect to it.
echo "==> Cleaning stale cocod runtime files..."
rm -f "${COCOD_DIR}/cocod.sock" "${COCOD_DIR}/cocod.sock.startup.lock"

if [[ -f "${COCOD_DIR}/cocod.pid" ]]; then
    cocod_pid="$(cat "${COCOD_DIR}/cocod.pid" 2>/dev/null || true)"
    if [[ ! "${cocod_pid}" =~ ^[0-9]+$ ]] || ! ps -p "${cocod_pid}" -o args= 2>/dev/null | grep -q '[c]ocod'; then
        echo "==> Removing stale cocod pid file (${COCOD_DIR}/cocod.pid)"
        rm -f "${COCOD_DIR}/cocod.pid"
    fi
fi

if [[ ! -f /app/data/.initialized ]]; then
    echo "==> First run detected. Initializing wallet/data files..."
    # cocod init is idempotent-ish but may exit non-zero when already initialized.
    # Run it as the same user as the app so generated files are not root-owned.
    gosu cloudron:cloudron env HOME="$HOME" ROUTSTRD_DIR="$ROUTSTRD_DIR" COCOD_DIR="$COCOD_DIR" cocod init </dev/null 2>&1 || true
    touch /app/data/.initialized
    chown -R cloudron:cloudron /app/data
    echo "==> Initialization complete."
fi

# Ensure routstrd's config.json has authUrl pointing to the auth proxy so the
# CLI routes management commands (npubs, clients, usage) through it. Also apply
# ROUTSTRD_MODELS_PUBKEY (when set) so the daemon fetches the routstr-21 model
# allowlist from the operator's chosen Nostr pubkey.
ROUTSTRD_CONFIG="${ROUTSTRD_DIR}/config.json"
AUTH_URL="http://localhost:${ROUTSTRD_AUTH_PORT}"
echo "==> Configuring authUrl (${AUTH_URL}) in ${ROUTSTRD_CONFIG}..."
bun -e "
    const path = process.argv[1];
    const authUrl = process.argv[2];
    const modelsPubkey = process.argv[3] || '';
    let c = {};
    try {
      c = JSON.parse(await Bun.file(path).text());
    } catch {}
    c.authUrl = authUrl;
    if (modelsPubkey) c.routstrModelsPubkey = modelsPubkey;
    await Bun.write(path, JSON.stringify(c, null, 2));
" "${ROUTSTRD_CONFIG}" "${AUTH_URL}" "${ROUTSTRD_MODELS_PUBKEY:-}"
chown cloudron:cloudron "${ROUTSTRD_CONFIG}" 2>/dev/null || true
echo "==> Starting supervisord..."
exec /usr/bin/supervisord --configuration /etc/supervisor/supervisord-cloudron.conf -i RoutstrdApp
