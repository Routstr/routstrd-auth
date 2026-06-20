import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync, existsSync } from "fs";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  type Event,
} from "nostr-tools";
import { AuthProxy } from "./proxy";
import { AuthStore } from "./store";
import type { AuthProxyConfig } from "./config";

// ─── DB helpers (template from deleted store.test.ts @ 0deebbb) ───────────────

function tmpDbPath(): string {
  return join(tmpdir(), `routstrd-auth-proxy-test-${randomUUID()}.db`);
}

function createTestDb(path: string): Database {
  const db = new Database(path);
  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_storage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  return db;
}

function seedClients(
  db: Database,
  clients: Array<{ clientId: string; name: string; apiKey: string; ownerNpub?: string }>,
) {
  const clientRows = clients.map((c) => ({
    clientId: c.clientId,
    name: c.name,
    apiKey: c.apiKey,
    createdAt: Date.now(),
    lastUsed: null,
    ownerNpub: c.ownerNpub,
  }));
  db.query("INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('client_ids', ?)").run(
    JSON.stringify(clientRows),
  );
}

// ─── NIP-98 signing helper ────────────────────────────────────────────────────

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface NostrAuthOpts {
  url: string;
  method: string;
  body?: Uint8Array;
  createdAt?: number;
}

async function nostrAuthHeader(sk: Uint8Array, opts: NostrAuthOpts): Promise<string> {
  const tags: string[][] = [
    ["u", opts.url],
    ["method", opts.method],
  ];
  if (opts.body && opts.body.byteLength > 0) {
    tags.push(["payload", await sha256Hex(opts.body)]);
  }
  const event: Event = finalizeEvent(
    {
      kind: 27235,
      created_at: opts.createdAt ?? Math.round(Date.now() / 1000),
      tags,
      content: "",
    },
    sk,
  );
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

// ─── Upstream mock ────────────────────────────────────────────────────────────

const UPSTREAM_PORT = 8799;
const UPSTREAM = `http://localhost:${UPSTREAM_PORT}`;
let upstreamServer: ReturnType<typeof Bun.serve> | null = null;
const upstreamHits: Array<{ path: string; method: string }> = [];

function startUpstream() {
  upstreamServer = Bun.serve({
    port: UPSTREAM_PORT,
    fetch(req) {
      const url = new URL(req.url);
      upstreamHits.push({ path: url.pathname, method: req.method });
      return new Response(JSON.stringify({ forwarded: true, path: url.pathname }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

// ─── Test config / proxy factory ──────────────────────────────────────────────

let dbPath: string;
let proxy: AuthProxy;

function makeConfig(path: string): AuthProxyConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    upstream: UPSTREAM,
    dbPath: path,
    configFile: "",
    adminPubkeys: [],
    invalidAdminPubkeys: [],
    trustForwardedHeaders: false,
  };
}

// Build the request against the upstream-less public origin so the NIP-98 `u`
// tag matches what the proxy reconstructs (no forwarded headers in play).
const ORIGIN = "http://localhost";

beforeEach(() => {
  upstreamHits.length = 0;
  dbPath = tmpDbPath();
  const db = createTestDb(dbPath);
  seedClients(db, [
    { clientId: "alice-app", name: "Alice App", apiKey: "sk-alice-123", ownerNpub: "npubAlice" },
  ]);
  db.close();
  proxy = new AuthProxy(makeConfig(dbPath));
});

afterEach(() => {
  proxy.close();
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

// register a fresh npub directly in the DB via a short-lived store
function registerNpub(role: "admin" | "user"): { sk: Uint8Array; pubkey: string } {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const store = new AuthStore(dbPath);
  store.addNpub(pubkey, role);
  store.close();
  return { sk, pubkey };
}

// ─── Static path classifiers (pure) ────────────────────────────────────────────

describe("AuthProxy path classifiers", () => {
  it("classifies public paths (exact + prefix)", () => {
    expect(AuthProxy.isPublicPath("/health")).toBe(true);
    expect(AuthProxy.isPublicPath("/ping")).toBe(true);
    expect(AuthProxy.isPublicPath("/models")).toBe(true);
    expect(AuthProxy.isPublicPath("/v1/models")).toBe(true);
    expect(AuthProxy.isPublicPath("/models/foo-bar")).toBe(true); // prefix
    expect(AuthProxy.isPublicPath("/v1/models/gpt")).toBe(true); // prefix
  });

  it("does not treat wallet/chat paths as public", () => {
    expect(AuthProxy.isPublicPath("/wallet/balance")).toBe(false);
    expect(AuthProxy.isPublicPath("/wallet/send/cashu")).toBe(false);
    expect(AuthProxy.isPublicPath("/v1/chat/completions")).toBe(false);
    // A path that merely starts with "/model" but not the public prefix:
    expect(AuthProxy.isPublicPath("/models-secret")).toBe(false);
  });

  it("classifies admin paths", () => {
    expect(AuthProxy.isAdminPath("/wallet/send/cashu")).toBe(true);
    expect(AuthProxy.isAdminPath("/wallet/send/bolt11")).toBe(true);
    expect(AuthProxy.isAdminPath("/wallet/balance")).toBe(false);
  });

  it("classifies npub-restricted paths", () => {
    expect(AuthProxy.isNpubRestrictedPath("/wallet/balance")).toBe(true);
    expect(AuthProxy.isNpubRestrictedPath("/wallet/status")).toBe(true);
    expect(AuthProxy.isNpubRestrictedPath("/wallet/receive/cashu")).toBe(true);
    expect(AuthProxy.isNpubRestrictedPath("/wallet/send/cashu")).toBe(false); // admin, not npub-restricted
  });

  it("isRestrictedPath is the union of admin + npub-restricted", () => {
    expect(AuthProxy.isRestrictedPath("/wallet/send/cashu")).toBe(true); // admin
    expect(AuthProxy.isRestrictedPath("/wallet/balance")).toBe(true); // npub
    expect(AuthProxy.isRestrictedPath("/v1/chat/completions")).toBe(false);
    expect(AuthProxy.isRestrictedPath("/health")).toBe(false);
  });
});

// ─── Request-level authorization matrix ────────────────────────────────────────

describe("AuthProxy.handle authorization matrix", () => {
  beforeEach(() => startUpstream());
  afterEach(() => {
    upstreamServer?.stop(true);
    upstreamServer = null;
  });

  // --- Public ---

  it("forwards public paths without auth", async () => {
    const res = await proxy.handle(new Request(`${ORIGIN}/health`, { method: "GET" }));
    expect(res.status).toBe(200);
    expect(upstreamHits.at(-1)?.path).toBe("/health");
  });

  // --- Missing auth ---

  it("returns 401 when auth missing on a protected path", async () => {
    const res = await proxy.handle(
      new Request(`${ORIGIN}/v1/chat/completions`, { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  // --- Bearer ---

  it("rejects Bearer on a restricted (npub) path with 403", async () => {
    const res = await proxy.handle(
      new Request(`${ORIGIN}/wallet/balance`, {
        method: "GET",
        headers: { authorization: "Bearer sk-alice-123" },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("API keys cannot access");
  });

  it("rejects Bearer on an admin path with 403", async () => {
    const res = await proxy.handle(
      new Request(`${ORIGIN}/wallet/send/cashu`, {
        method: "POST",
        headers: { authorization: "Bearer sk-alice-123" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("API keys cannot access");
  });

  it("forwards a valid Bearer on a default-protected non-restricted path", async () => {
    const res = await proxy.handle(
      new Request(`${ORIGIN}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer sk-alice-123" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(upstreamHits.at(-1)?.path).toBe("/v1/chat/completions");
  });

  it("rejects an unknown Bearer API key with 401", async () => {
    const res = await proxy.handle(
      new Request(`${ORIGIN}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer sk-not-real" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("Invalid API key");
  });

  it("rejects Bearer on /clients with 403 (routes via authenticateNpub)", async () => {
    const res = await proxy.handle(
      new Request(`${ORIGIN}/clients`, {
        method: "GET",
        headers: { authorization: "Bearer sk-alice-123" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects Bearer on /npubs with 403", async () => {
    // /npubs already has a bootstrap admin so it requires admin NIP-98.
    registerNpub("admin");
    const res = await proxy.handle(
      new Request(`${ORIGIN}/npubs`, {
        method: "POST",
        headers: { authorization: "Bearer sk-alice-123" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });

  // --- Nostr / NIP-98 ---

  it("rejects a Nostr token from an unregistered npub with 403 on a default-protected path", async () => {
    const sk = generateSecretKey();
    // Register at least one npub so the error path is the 'not registered' branch.
    registerNpub("admin");
    const url = `${ORIGIN}/v1/chat/completions`;
    const body = new TextEncoder().encode("{}");
    const header = await nostrAuthHeader(sk, { url, method: "POST", body });
    const res = await proxy.handle(
      new Request(url, { method: "POST", headers: { authorization: header }, body }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a user-role npub on an admin path with 403", async () => {
    const { sk } = registerNpub("user");
    const url = `${ORIGIN}/wallet/send/cashu`;
    const body = new TextEncoder().encode("{}");
    const header = await nostrAuthHeader(sk, { url, method: "POST", body });
    const res = await proxy.handle(
      new Request(url, { method: "POST", headers: { authorization: header }, body }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("Admin access required");
  });

  it("forwards an admin npub on an admin path", async () => {
    const { sk } = registerNpub("admin");
    const url = `${ORIGIN}/wallet/send/cashu`;
    const body = new TextEncoder().encode("{}");
    const header = await nostrAuthHeader(sk, { url, method: "POST", body });
    const res = await proxy.handle(
      new Request(url, { method: "POST", headers: { authorization: header }, body }),
    );
    expect(res.status).toBe(200);
    expect(upstreamHits.at(-1)?.path).toBe("/wallet/send/cashu");
  });

  it("forwards a user npub on an npub-restricted (non-admin) path", async () => {
    const { sk } = registerNpub("user");
    const url = `${ORIGIN}/wallet/balance`;
    const header = await nostrAuthHeader(sk, { url, method: "GET" });
    const res = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: header } }),
    );
    expect(res.status).toBe(200);
    expect(upstreamHits.at(-1)?.path).toBe("/wallet/balance");
  });

  it("rejects an unregistered npub on an npub-restricted path with 403", async () => {
    registerNpub("admin"); // ensure countNpubs > 0
    const sk = generateSecretKey();
    const url = `${ORIGIN}/wallet/balance`;
    const header = await nostrAuthHeader(sk, { url, method: "GET" });
    const res = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: header } }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects an expired Nostr token with 401", async () => {
    const { sk } = registerNpub("user");
    const url = `${ORIGIN}/wallet/balance`;
    const header = await nostrAuthHeader(sk, {
      url,
      method: "GET",
      createdAt: Math.round(Date.now() / 1000) - 120,
    });
    const res = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: header } }),
    );
    expect(res.status).toBe(401);
  });

  // --- Replay protection (nonce/jti cache) ---

  it("rejects the same Nostr token replayed within the window (nonce cache)", async () => {
    const { sk } = registerNpub("user");
    const url = `${ORIGIN}/wallet/balance`;
    const header = await nostrAuthHeader(sk, { url, method: "GET" });
    const first = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: header } }),
    );
    const second = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: header } }),
    );
    expect(first.status).toBe(200);
    // The second presentation of the identical signed token is a replay.
    expect(second.status).toBe(401);
    expect(((await second.json()) as { error: string }).error).toContain("replay");
  });

  it("rejects a replay on an npub-restricted path via authenticateNpub", async () => {
    const { sk } = registerNpub("user");
    const url = `${ORIGIN}/wallet/balance`;
    const header = await nostrAuthHeader(sk, { url, method: "GET" });
    const first = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: header } }),
    );
    const second = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: header } }),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it("allows two DISTINCT tokens from the same npub (replay cache keys on event id, not pubkey)", async () => {
    const { sk } = registerNpub("user");
    const url = `${ORIGIN}/wallet/balance`;
    const headerA = await nostrAuthHeader(sk, { url, method: "GET" });
    // A second sign produces a different event id (different timestamp/nonce of
    // the signature), so it must NOT be treated as a replay.
    const headerB = await nostrAuthHeader(sk, { url, method: "GET" });
    const a = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: headerA } }),
    );
    const b = await proxy.handle(
      new Request(url, { method: "GET", headers: { authorization: headerB } }),
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  // --- Trusted-proxy / x-forwarded gating ---

  it("ignores forged x-forwarded-* by default and rejects a cross-host token", async () => {
    const { sk } = registerNpub("user");
    // Token signed for an attacker-chosen public host.
    const header = await nostrAuthHeader(sk, {
      url: "https://evil.test/wallet/balance",
      method: "GET",
    });
    // Request arrives at localhost with forged forwarded headers. With the proxy
    // configured NOT to trust forwarded headers (default), the URL tag must not
    // match and the token is rejected.
    const res = await proxy.handle(
      new Request(`${ORIGIN}/wallet/balance`, {
        method: "GET",
        headers: {
          authorization: header,
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "https",
        },
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("URL tag does not match");
  });

  it("honors x-forwarded-* for a legitimately configured trusted proxy", async () => {
    // Operator declares this process sits behind a trusted reverse proxy.
    const trustedProxy = new AuthProxy({ ...makeConfig(dbPath), trustForwardedHeaders: true });
    try {
      const sk = generateSecretKey();
      const pubkey = getPublicKey(sk);
      const store = new AuthStore(dbPath);
      store.addNpub(pubkey, "user");
      store.close();

      // Client signs for the PUBLIC host the trusted proxy fronts.
      const header = await nostrAuthHeader(sk, {
        url: "https://api.example.com/wallet/balance",
        method: "GET",
      });
      const res = await trustedProxy.handle(
        new Request(`${ORIGIN}/wallet/balance`, {
          method: "GET",
          headers: {
            authorization: header,
            "x-forwarded-host": "api.example.com",
            "x-forwarded-proto": "https",
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(upstreamHits.at(-1)?.path).toBe("/wallet/balance");
    } finally {
      trustedProxy.close();
    }
  });
});
