#!/bin/bash
set -eu

: "${ROUTSTRD_AUTH_PORT:=8008}"
: "${ROUTSTRD_AUTH_HOST:=0.0.0.0}"
: "${ROUTSTRD_UPSTREAM:=http://localhost:8009}"
: "${ROUTSTRD_DB_PATH:=/app/data/routstr.db}"

export ROUTSTRD_AUTH_PORT ROUTSTRD_AUTH_HOST ROUTSTRD_UPSTREAM ROUTSTRD_DB_PATH

for i in $(seq 1 120); do
    if [[ -f "$ROUTSTRD_DB_PATH" ]] && /usr/local/bin/bun -e "const r=await fetch(process.env.ROUTSTRD_UPSTREAM + '/health'); process.exit(r.ok ? 0 : 1)" >/dev/null 2>&1; then
        exec /usr/local/bin/bun run /app/code/src/index.ts start
    fi

    if [[ "$i" = "1" ]]; then
        echo "Waiting for routstrd to create ${ROUTSTRD_DB_PATH} and become healthy..."
    fi
    sleep 1
done

echo "Timed out waiting for routstrd to become ready." >&2
exit 1
