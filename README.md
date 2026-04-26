# routstrd-auth

Standalone **auth proxy** for [routstrd](https://github.com/routstr/routstrd). Sits in front of the daemon, validates `Authorization: Bearer sk-...` tokens or `Authorization: Nostr <base64-event>` NIP-98 events, and forwards requests.

## Why?

Keeps auth as a separate, replaceable layer. The daemon itself runs unauthenticated on localhost only; the proxy is the public-facing gatekeeper.

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────┐
│   Clients   │ ───► │  routstrd-auth   │ ───► │  routstrd    │
│ (CLI, Pi,   │      │  :8008 (public)  │      │  :8009 (local)│
│  OpenCode)  │      │  Bearer/NIP-98   │      │  No auth     │
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
| `ROUTSTRD_AUTH_ADMIN_NPUBS` | unset | Comma/space-separated admin `npub...` values allowed to call admin endpoints like `/clients/add` |
| `ROUTSTRD_AUTH_ADMIN_PUBKEYS` | unset | Comma/space-separated admin 64-char hex Nostr pubkeys; alternative to `ROUTSTRD_AUTH_ADMIN_NPUBS` |

## Usage

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

## Running alongside routstrd

1. Start routstrd on a local-only port (e.g. `8009`).
2. Start `routstrd-auth` on the public port (`8008`).
3. Clients send either `Authorization: Bearer sk-...` or a NIP-98 `Authorization: Nostr <base64-event>` header to `:8008`.

## Auth behaviour

- **Public endpoints** — `/health`, `/ping`, `/models`, `/v1/models`, and model-detail paths under `/models/` or `/v1/models/` are forwarded immediately with no token.
- **Protected endpoints** — every other endpoint requires either:
  - a valid `Bearer` token that exists in the shared DB; or
  - a valid NIP-98 event in `Authorization: Nostr <base64-event>`.
- **Admin endpoints** — `POST /clients/add` always requires NIP-98 auth from a configured admin Nostr pubkey. Bearer tokens are not accepted for this endpoint, and there is no unauthenticated bootstrap mode.
- **Forwarded headers** — the proxy strips `Authorization` before proxying.
  - Bearer auth injects `x-routstr-client-id: <clientId>`.
  - NIP-98 auth injects `x-routstr-nostr-pubkey: <pubkey>` and `x-routstr-client-id: nostr:<pubkey>`.

## NIP-98 usage

For protected requests, sign a Nostr `kind: 27235` event whose tags bind the request:

- `['u', '<absolute public URL including query string>']`
- `['method', '<HTTP method>']`
- `['payload', '<sha256 hex of the raw request body>']` for non-empty request bodies

Then base64 encode the signed event JSON and send:

```http
Authorization: Nostr <base64-event-json>
```

The proxy validates kind, timestamp (±60s), URL, method, body hash, and signature. On success the authenticated identity is the event `pubkey`.

See [`NIP98.md`](./NIP98.md) for details.

## Admin bootstrap

Because `/clients/add` is protected from the first request, configure at least one admin Nostr identity before exposing the proxy:

```bash
export ROUTSTRD_AUTH_ADMIN_NPUBS="npub1..."
# or use raw hex pubkeys:
export ROUTSTRD_AUTH_ADMIN_PUBKEYS="<64-char-hex-pubkey>"
```

Then create clients by sending `POST /clients/add` with a valid NIP-98 `Authorization: Nostr ...` header signed by one of those configured admin keys. The proxy forwards the request to routstrd only after verifying the signature and checking the pubkey against the admin list.

## License

MIT
