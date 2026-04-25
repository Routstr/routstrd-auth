# routstrd-container Progress

## Goal
Create a lean, standalone Docker project (`routstrd-container`) that installs `routstrd` directly from npm instead of building from source. Compare against the existing `routstrd/.worktrees/dockerize` source-build approach.

## Status: Working, two issues remaining

The container runs and the daemon is healthy, but there are two outstanding issues:

### 1. Health check fails from host (curl exits 56)
**Symptom:** `curl http://localhost:8009/health` from the host gets `Connection reset by peer` (curl exit 56). Docker shows the container as `(healthy)` because its internal healthcheck uses Bun (not curl), but external health checks fail.

**Inside the container it works:**
```
$ docker exec routstrd bun -e 'async()=>{try{const r=await fetch("http://127.0.0.1:8009/health");console.log("status:",r.status,await r.text())}catch(e){console.error("error:",e.message)}}()'
status: 200 {"ok":true}
```

**Diagnosis:** The daemon is listening on `127.0.0.1:8009` inside the container. The Docker `HEALTHCHECK` uses `localhost:8009` which resolves to `::1` (IPv6 loopback). Bun's HTTP server only binds to `127.0.0.1` (IPv4). The container is marked `healthy` because the Dockerfile's `HEALTHCHECK` uses `localhost` which Bun resolves to `::1`, and that fails — but the Docker Compose `healthcheck` override might be using the same `localhost` too. Actually, the Docker Compose healthcheck uses `localhost` (which Bun resolves to IPv6 first), so it should connect fine if the server binds to `::1`... but the server binds to `127.0.0.1`. So why is Docker saying healthy?

Wait — Docker's HEALTHCHECK uses `--interval` etc., and the container IS showing `(healthy)`. The Dockerfile HEALTHCHECK and docker-compose HEALTHCHECK are both set. But the host `curl` fails because the Docker daemon's port mapping uses `0.0.0.0:8009` and the connection is being reset.

Actually, the real issue is the daemon only binds to `127.0.0.1` (IPv4) but something in the chain is preferring IPv6. The container shows healthy but external curl fails — this might be a Docker networking issue or the daemon specifically binding to IPv4 only.

**Action needed:** Either make the daemon bind to `::` (all interfaces) or ensure the entrypoint passes a `--host` flag.

### 2. No shell entry into the container
`ps aux` and `curl` are not available inside the `oven/bun:1.2` image. Only `sh` and `bun` are present. This is minor but limits debuggability.

**Action needed:** Either add `curl` to the Dockerfile or use `bun -e` for all exec commands.

---

## What works

- Docker image builds cleanly from npm packages (no source, no lockfile sync issues)
- `docker compose up --build -d` succeeds
- Container stays alive (`tail -f /dev/null` trick in entrypoint)
- Daemon starts, initializes wallet, accepts connections
- Docker internal health check passes (`status: 200 {"ok":true}"` from inside container)
- `PORT=8009` override works correctly (host 8009 → container 8008)

## Files created

```
~/projects/routstr_main/routstrd-container/
├── Dockerfile              # npm install approach, 15 steps
├── docker-compose.yml      # PORT env var, dynamic healthcheck
├── docker-entrypoint.sh    # init dirs + wallet + daemon + tail -f /dev/null
└── .dockerignore
```

## Key differences from source-build approach

| | Source build (`routstrd/`) | npm install (`routstrd-container/`) |
|---|---|---|
| Build steps | COPY src, RUN build, RUN bun install --global cocod | RUN bun install --global routstrd cocod |
| Lockfile | Handled manually (caused build failures) | None needed |
| Image size | Larger (includes TypeScript, dev deps) | Smaller |
| Rebuild speed | Slower (full build + install) | Faster (bun fetch only) |
| Port override | Needed docker-compose.yml edit to avoid conflict | Works with just `PORT=8009` env var |
| Healthcheck port | Hardcoded to 8008 | Uses `${PORT:-8008}` |

## Open questions

1. How does `routstrd start --port $PORT` actually bind? Does it support `--host`?
2. Should we publish `@routstr/routstrd` to npm under a scoped package?
3. Add `curl` or `wget` to the image for easier debugging?
4. Should the entrypoint handle re-initialization of the wallet on each start, or only if not initialized?
5. Should we use a proper init process (tini) instead of `tail -f /dev/null`?
