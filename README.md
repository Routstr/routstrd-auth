# routstrd-auth

Standalone **auth proxy** for [routstrd](https://github.com/routstr/routstrd). Sits in front of the daemon, validates `Authorization: Bearer sk-...` tokens, and forwards requests.

## Why?

Keeps auth as a separate, replaceable layer. The daemon itself runs unauthenticated on localhost only; the proxy is the public-facing gatekeeper.

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────┐
│   Clients   │ ───► │  routstrd-auth   │ ───► │  routstrd    │
│ (CLI, Pi,   │      │  :8008 (public)  │      │  :8009 (local)│
│  OpenCode)  │      │  Bearer token    │      │  No auth     │
└─────────────┘      └──────────────────┘      └──────────────┘
```

## Configuration

All values have sensible defaults and can be overridden via environment variables or CLI flags.

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTSTRD_AUTH_PORT` | `8008` | Public port |
| `ROUTSTRD_AUTH_HOST` | `0.0.0.0` | Bind host |
| `ROUTSTRD_UPSTREAM` | `http://localhost:8009` | Upstream routstrd URL |
| `ROUTSTRD_DB_PATH` | `~/.routstrd/routstr.db` | Shared SQLite DB |
| `ROUTSTRD_DIR` | `~/.routstrd` | Base config directory |
| `COCOD_DIR` | `~/.cocod` | Wallet data directory |

## Usage

### Vanilla Docker

This project is intended to be run with plain Docker. Docker Compose is not required.

Build the image:

```bash
docker build -t routstrd .
```

Create a persistent data volume:

```bash
docker volume create routstrd-data
```

Run the container:

```bash
docker run -d \
  --name routstrd \
  --restart unless-stopped \
  -p 8009:8008 \
  -v routstrd-data:/data \
  routstrd
```

The service is now available on the host at:

```bash
http://localhost:8009
```

Check the health endpoint:

```bash
curl http://localhost:8009/health
```

Follow logs:

```bash
docker logs -f routstrd
```

Stop and remove the container:

```bash
docker stop routstrd
docker rm routstrd
```

Rebuild and restart after changes:

```bash
docker stop routstrd
docker rm routstrd
docker build -t routstrd .
docker run -d \
  --name routstrd \
  --restart unless-stopped \
  -p 8009:8008 \
  -v routstrd-data:/data \
  routstrd
```

If you want the host to use port `8008` instead of `8009`, change the port mapping to:

```bash
-p 8008:8008
```

> Note: `EXPOSE 8008` in the `Dockerfile` only documents the container port. Host port publishing, restart policy, container name, and volume mounting are configured with `docker run` flags.

### Local development

```bash
# Install dependencies
bun install

# Validate config & DB connectivity
bun run src/index.ts validate

# Start the proxy
bun run src/index.ts start

# Start on a different port
bun run src/index.ts start -p 8080

# Point at a custom DB
bun run src/index.ts start -d /path/to/routstr.db
```

### NIP-98 client helper

`src/nip98-client.ts` signs each request with a Nostr private key and can add a client through `/clients/add`, then fetch `/clients` and print the current list.

The private key must belong to one of the configured admin pubkeys (`ROUTSTRD_AUTH_ADMIN_NPUBS` or `ROUTSTRD_AUTH_ADMIN_PUBKEYS`) because `/clients/add` is admin-only.

```bash
# Add a client, then list all clients
bun run client -- \
  --url http://localhost:8008 \
  --key nsec1... \
  --name "My Laptop"

# Or use env vars
export ROUTSTRD_AUTH_URL=http://localhost:8008
export NOSTR_NSEC=nsec1...
bun run client -- --name "My Laptop"

# Just list clients
bun run client -- --json
```

The helper creates `Authorization: Nostr <base64-event>` headers whose signed event binds the exact URL, HTTP method, and POST body hash, matching the validation in `src/nip98.ts`.

## Running alongside routstrd

1. Start routstrd on a local-only port (e.g. `8009`).
2. Start `routstrd-auth` on the public port (`8008`).
3. Clients send `Authorization: Bearer sk-...` to `:8008` as normal.

## Auth behaviour

- **Public endpoints** (health, models, balance, etc.) — forwarded immediately, no token needed.
- **Protected endpoints** — require a valid `Bearer` token that exists in the shared DB.
- **Bootstrap** — `POST /clients/add` is allowed without auth when the DB has zero clients.
- **Forwarded headers** — the proxy strips `Authorization` and injects `x-routstr-client-id` so the daemon knows which client made the request.

## License

MIT
