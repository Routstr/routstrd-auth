import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { AuthProxy, type AuthProxyConfig } from "./proxy";
import type { AuthStore } from "./store";

/**
 * Tests for model allowlist enforcement (AUTH-001).
 *
 * Strategy: create a real AuthProxy with a temp SQLite DB, insert model data
 * directly into sdk_storage, and mock `fetch` so we can assert whether the
 * request was forwarded to upstream or blocked by the allowlist.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-auth-test-"));
  const dbPath = join(dir, "test.db");
  const db = new Database(dbPath);
  // Create the sdk_storage table that AuthStore expects.
  db.run("CREATE TABLE IF NOT EXISTS sdk_storage (key TEXT PRIMARY KEY, value TEXT)");
  // Create the npubs table that AuthStore.migrateNpubTable creates.
  db.run(`
    CREATE TABLE IF NOT EXISTS routstr_auth_npubs (
      pubkey TEXT PRIMARY KEY,
      npub TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      source TEXT NOT NULL DEFAULT 'api',
      role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user'))
    )
  `);
  db.close();
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function setModels(dbPath: string, models: string[]) {
  const db = new Database(dbPath);
  db.run(
    "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('routstr21Models', ?)",
    JSON.stringify(models),
  );
  db.close();
}

function setClients(dbPath: string, clients: { clientId: string; name: string; apiKey: string; createdAt: number; lastUsed: number | null }[]) {
  const db = new Database(dbPath);
  db.run(
    "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('client_ids', ?)",
    JSON.stringify(clients),
  );
  db.close();
}

function makeConfig(dbPath: string, overrides: Partial<AuthProxyConfig> = {}): AuthProxyConfig {
  return {
    port: 0, // not used — we call handle() directly
    host: "127.0.0.1",
    upstream: "http://localhost:9999",
    dbPath,
    configFile: "",
    adminPubkeys: [],
    invalidAdminPubkeys: [],
    modelAllowlistEnabled: true,
    allowedModelsOverride: null,
    ...overrides,
  };
}

const TEST_MODELS = [
  "routstr/gpt-4o",
  "routstr/claude-3.5-sonnet",
  "routstr/llama-3.1-70b",
];

const TEST_API_KEY = "sk-test-key-12345";
const TEST_CLIENT = {
  clientId: "test-client",
  name: "Test Client",
  apiKey: TEST_API_KEY,
  createdAt: Date.now(),
  lastUsed: null,
};

// ─── Mock upstream ────────────────────────────────────────────────────────────

/** A mock fetch that records calls and returns a generic 200 response. */
function mockFetchUpstream() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const originalFetch = globalThis.fetch;

  const mocked = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body;
    let bodyStr: string | undefined;
    if (body instanceof Uint8Array) {
      bodyStr = new TextDecoder().decode(body);
    } else if (typeof body === "string") {
      bodyStr = body;
    } else if (body instanceof ReadableStream) {
      bodyStr = "[stream]";
    }
    calls.push({ url, method: init?.method ?? "GET", body: bodyStr });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  globalThis.fetch = mocked as unknown as typeof fetch;
  return {
    calls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Model Allowlist Enforcement (AUTH-001)", () => {
  let tmp: { dbPath: string; cleanup: () => void };
  let upstream: ReturnType<typeof mockFetchUpstream>;
  let proxy: AuthProxy;

  beforeEach(() => {
    tmp = createTmpDb();
    setModels(tmp.dbPath, TEST_MODELS);
    setClients(tmp.dbPath, [TEST_CLIENT]);
    upstream = mockFetchUpstream();
  });

  afterEach(() => {
    proxy?.close();
    upstream.restore();
    tmp.cleanup();
  });

  // --- Bearer path tests ---

  describe("Bearer auth path", () => {
    it("allows a request with a whitelisted model", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "routstr/gpt-4o", messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });

    it("blocks a request with a non-whitelisted model (403)", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "openai/gpt-5-turbo", messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("not in the Routstr 21 allowlist");
      expect(body.error).toContain("openai/gpt-5-turbo");
      // Should not have forwarded to upstream
      expect(upstream.calls).toHaveLength(0);
    });

    it("includes available models in the 403 error", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "forbidden/model", messages: [] }),
      });

      const res = await proxy.handle(req);
      const body = await res.json();
      expect(body.error).toContain("routstr/gpt-4o");
      expect(body.error).toContain("routstr/claude-3.5-sonnet");
      expect(body.error).toContain("routstr/llama-3.1-70b");
    });

    it("allows requests with no model field in body", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });

    it("forwards GET requests without model check", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      // GET /models is a public path — should forward immediately
      const req = new Request("http://localhost:8008/models", {
        method: "GET",
        headers: { "Authorization": `Bearer ${TEST_API_KEY}` },
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });
  });

  // --- Fail-open behavior ---

  describe("fail-open on empty allowlist", () => {
    it("allows all models when DB allowlist is empty", async () => {
      // Create a DB with no routstr21Models key
      const emptyTmp = createTmpDb();
      setClients(emptyTmp.dbPath, [TEST_CLIENT]);

      const localUpstream = mockFetchUpstream();
      try {
        proxy = new AuthProxy(makeConfig(emptyTmp.dbPath));

        const req = new Request("http://localhost:8008/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${TEST_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "any/random-model", messages: [] }),
        });

        const res = await proxy.handle(req);
        expect(res.status).toBe(200);
        expect(localUpstream.calls).toHaveLength(1);
      } finally {
        proxy.close();
        localUpstream.restore();
        emptyTmp.cleanup();
      }
    });
  });

  // --- Config overrides ---

  describe("config: modelAllowlistEnabled", () => {
    it("allows all models when enforcement is disabled", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath, { modelAllowlistEnabled: false }));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "forbidden/model", messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });
  });

  describe("config: allowedModelsOverride", () => {
    it("uses override list instead of DB", async () => {
      proxy = new AuthProxy(
        makeConfig(tmp.dbPath, { allowedModelsOverride: ["custom/model-only"] }),
      );

      // This model is in the DB but NOT in the override → should be blocked
      const req1 = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "routstr/gpt-4o", messages: [] }),
      });

      const res1 = await proxy.handle(req1);
      expect(res1.status).toBe(403);

      // This model is in the override → should be allowed
      const req2 = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "custom/model-only", messages: [] }),
      });

      const res2 = await proxy.handle(req2);
      expect(res2.status).toBe(200);
    });

    it("fail-opens when override is an empty array", async () => {
      proxy = new AuthProxy(
        makeConfig(tmp.dbPath, { allowedModelsOverride: [] }),
      );

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "any/model", messages: [] }),
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
    });
  });

  // --- Non-JSON bodies ---

  describe("non-JSON bodies", () => {
    it("skips model check for non-JSON body", async () => {
      proxy = new AuthProxy(makeConfig(tmp.dbPath));

      const req = new Request("http://localhost:8008/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${TEST_API_KEY}`,
          "Content-Type": "text/plain",
        },
        body: "plain text body",
      });

      const res = await proxy.handle(req);
      expect(res.status).toBe(200);
      expect(upstream.calls).toHaveLength(1);
    });
  });

  // --- Store method ---

  describe("AuthStore.getRoutstr21Models()", () => {
    it("returns models from sdk_storage", () => {
      const { AuthStore } = require("./store");
      const store = new AuthStore(tmp.dbPath);
      const models = store.getRoutstr21Models();
      expect(models).toEqual(TEST_MODELS);
      store.close();
    });

    it("returns empty array when key is missing", () => {
      const emptyTmp = createTmpDb();
      const { AuthStore } = require("./store");
      const store = new AuthStore(emptyTmp.dbPath);
      const models = store.getRoutstr21Models();
      expect(models).toEqual([]);
      store.close();
      emptyTmp.cleanup();
    });

    it("returns empty array for invalid JSON", () => {
      const badTmp = createTmpDb();
      const db = new Database(badTmp.dbPath);
      db.run(
        "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('routstr21Models', 'not-json')",
      );
      db.close();

      const { AuthStore } = require("./store");
      const store = new AuthStore(badTmp.dbPath);
      const models = store.getRoutstr21Models();
      expect(models).toEqual([]);
      store.close();
      badTmp.cleanup();
    });

    it("returns empty array for non-array JSON", () => {
      const badTmp = createTmpDb();
      const db = new Database(badTmp.dbPath);
      db.run(
        "INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('routstr21Models', '\"just-a-string\"')",
      );
      db.close();

      const { AuthStore } = require("./store");
      const store = new AuthStore(badTmp.dbPath);
      const models = store.getRoutstr21Models();
      expect(models).toEqual([]);
      store.close();
      badTmp.cleanup();
    });
  });
});
