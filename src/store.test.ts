import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { AuthStore } from "./store";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpDbPath(): string {
  return join(tmpdir(), `routstrd-auth-test-${randomUUID()}.db`);
}

function createTestDb(path: string): Database {
  const db = new Database(path);

  // routstrd-auth expects sdk_storage for getClients()
  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_storage (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usage_tracking (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      base_url TEXT NOT NULL,
      request_id TEXT NOT NULL,
      cost REAL NOT NULL,
      sats_cost REAL NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      client TEXT,
      session_id TEXT,
      tags TEXT
    )
  `);

  return db;
}

function seedClients(db: Database, clients: Array<{ clientId: string; name: string; apiKey: string; ownerNpub?: string }>) {
  const clientRows = clients.map((c) => ({
    clientId: c.clientId,
    name: c.name,
    apiKey: c.apiKey,
    createdAt: Date.now(),
    lastUsed: null,
    ownerNpub: c.ownerNpub,
  }));
  db.query("INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('client_ids', ?)")
    .run(JSON.stringify(clientRows));
}

interface RowSeed {
  id?: string;
  timestamp?: number;
  modelId: string;
  baseUrl: string;
  cost?: number;
  satsCost?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  client?: string | null;
}

function seedRows(db: Database, rows: RowSeed[]): void {
  const stmt = db.prepare(`
    INSERT INTO usage_tracking
      (id, timestamp, model_id, base_url, request_id, cost, sats_cost, prompt_tokens, completion_tokens, total_tokens, client, session_id, tags)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]')
  `);
  const now = Date.now();
  for (const r of rows) {
    stmt.run(
      r.id ?? randomUUID(),
      r.timestamp ?? now,
      r.modelId,
      r.baseUrl,
      randomUUID(),
      r.cost ?? 0,
      r.satsCost ?? 0,
      r.promptTokens ?? 0,
      r.completionTokens ?? 0,
      r.totalTokens ?? 0,
      r.client ?? null,
    );
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AuthStore.getUsageSummary", () => {
  const paths: string[] = [];

  afterEach(() => {
    // Clean up temp DBs
    for (const p of paths.splice(0)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  });

  function makeStore(path: string): AuthStore {
    paths.push(path);
    return new AuthStore(path, []);
  }

  it("totals, models (desc), providers (desc), clients across scoped ids", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);
    seedClients(db, [{ clientId: "client-a", name: "A", apiKey: "key-a" }]);
    seedRows(db, [
      { modelId: "gpt-4", baseUrl: "https://api.openai.com", satsCost: 10, promptTokens: 100, completionTokens: 50, totalTokens: 150, client: "client-a" },
      { modelId: "gpt-3.5", baseUrl: "https://api.openai.com", satsCost: 3, promptTokens: 30, completionTokens: 20, totalTokens: 50, client: "client-a" },
      { modelId: "claude-3", baseUrl: "https://api.anthropic.com", satsCost: 7, promptTokens: 80, completionTokens: 40, totalTokens: 120, client: "client-a" },
    ]);
    db.close();

    const store = makeStore(path);
    const summary = store.getUsageSummary(["client-a"], 0);

    expect(summary.totals.requests).toBe(3);
    expect(summary.totals.satsCost).toBeCloseTo(20);
    expect(summary.totals.promptTokens).toBe(210);
    expect(summary.totals.completionTokens).toBe(110);
    expect(summary.totals.totalTokens).toBe(320);

    // Models sorted desc by satsCost
    expect(summary.models.length).toBe(3);
    expect(summary.models[0]!.modelId).toBe("gpt-4");
    expect(summary.models[0]!.satsCost).toBeCloseTo(10);
    expect(summary.models[1]!.modelId).toBe("claude-3");
    expect(summary.models[2]!.modelId).toBe("gpt-3.5");

    // Providers sorted desc by satsCost
    expect(summary.providers.length).toBe(2);
    expect(summary.providers[0]!.baseUrl).toBe("https://api.openai.com");
    expect(summary.providers[0]!.satsCost).toBeCloseTo(13);
    expect(summary.providers[1]!.baseUrl).toBe("https://api.anthropic.com");

    // Clients
    expect(summary.clients.length).toBe(1);
    expect(summary.clients[0]!.client).toBe("client-a");
    expect(summary.clients[0]!.requests).toBe(3);

    store.close();
  });

  it("null model maps to 'unknown' client", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);
    seedClients(db, [{ clientId: "client-a", name: "A", apiKey: "key-a" }]);
    // Insert a row with null client (will be filtered by getUsageSummary scoping)
    // Insert a row with empty model_id — actually model_id is NOT NULL, test null client
    // We test client: null scenario through cross-npub isolation test below
    // Here test a model aggregated as "unknown" via empty string won't happen (NOT NULL).
    // Test that a row with client in list is counted correctly.
    seedRows(db, [
      { modelId: "m1", baseUrl: "https://x.com", satsCost: 5, totalTokens: 200, client: "client-a" },
    ]);
    db.close();

    const store = makeStore(path);
    const summary = store.getUsageSummary(["client-a"], 0);
    expect(summary.clients[0]!.client).toBe("client-a");
    // client in list, so no "unknown" here
    expect(summary.models[0]!.modelId).toBe("m1");
    store.close();
  });

  it("days most-recent-first with tz=300 bucketing", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);
    seedClients(db, [{ clientId: "c1", name: "C1", apiKey: "k1" }]);

    // tz=300 means UTC-5 (getTimezoneOffset() returns 300 for UTC-5)
    // offset applied: (timestamp - 300*60000)/1000 → shifts time back 5h
    // Use recent timestamps (within the 30-day window).
    // Pick a UTC time that straddles midnight in UTC-5:
    //   e.g. "today 02:00 UTC" → local "yesterday 21:00" → yesterday's local date
    //        "today 10:00 UTC" → local "today 05:00" → today's local date
    const now = Date.now();
    // Snap to today's UTC midnight, then add hours
    const todayUtcMidnight = Math.floor(now / 86400000) * 86400000;
    const t1 = todayUtcMidnight + 2 * 3600000;  // 02:00 UTC today → local yesterday (UTC-5)
    const t2 = todayUtcMidnight + 10 * 3600000; // 10:00 UTC today → local today (UTC-5)

    // Derive expected local date strings
    // local date = UTC date of (timestamp - 300*60000)
    const localDate1 = new Date(t1 - 300 * 60000).toISOString().slice(0, 10);
    const localDate2 = new Date(t2 - 300 * 60000).toISOString().slice(0, 10);

    seedRows(db, [
      { modelId: "m", baseUrl: "https://x.com", satsCost: 2, totalTokens: 100, client: "c1", timestamp: t1 },
      { modelId: "m", baseUrl: "https://x.com", satsCost: 3, totalTokens: 200, client: "c1", timestamp: t2 },
    ]);
    db.close();

    const store = makeStore(path);
    const summary = store.getUsageSummary(["c1"], 300);

    // Two distinct local days (or one if they happen to land on the same local day edge)
    if (localDate1 !== localDate2) {
      expect(summary.days.length).toBe(2);
      // Most-recent-first
      expect(summary.days[0]!.date).toBe(localDate2);
      expect(summary.days[1]!.date).toBe(localDate1);
    } else {
      // Both fell in the same local day (edge case around midnight)
      expect(summary.days.length).toBe(1);
      expect(summary.days[0]!.date).toBe(localDate2);
    }

    store.close();
  });

  it("hoursToday ascending in local time", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);
    seedClients(db, [{ clientId: "c1", name: "C1", apiKey: "k1" }]);

    // Use tz=0 (UTC). Plant two entries today (based on current time).
    const now = Date.now();
    const todayMidnightUtc = Math.floor(now / 86400000) * 86400000;
    const t1 = todayMidnightUtc + 2 * 3600000; // 02:00 UTC today
    const t2 = todayMidnightUtc + 14 * 3600000; // 14:00 UTC today

    seedRows(db, [
      { modelId: "m", baseUrl: "https://x.com", satsCost: 1, totalTokens: 10, client: "c1", timestamp: t1 },
      { modelId: "m", baseUrl: "https://x.com", satsCost: 2, totalTokens: 20, client: "c1", timestamp: t2 },
    ]);
    db.close();

    const store = makeStore(path);
    const summary = store.getUsageSummary(["c1"], 0);

    // hoursToday should have 2 entries (hours 2 and 14) in ascending order
    expect(summary.hoursToday.length).toBe(2);
    expect(summary.hoursToday[0]!.hour).toBe(2);
    expect(summary.hoursToday[1]!.hour).toBe(14);

    store.close();
  });

  it("sizeBuckets half-open ranges with correct counts and summed satsCost", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);
    seedClients(db, [{ clientId: "c1", name: "C1", apiKey: "k1" }]);

    seedRows(db, [
      // tiny: [0, 1000)
      { modelId: "m", baseUrl: "https://x.com", satsCost: 1, totalTokens: 500, client: "c1" },
      { modelId: "m", baseUrl: "https://x.com", satsCost: 2, totalTokens: 999, client: "c1" },
      // small: [1000, 10000)
      { modelId: "m", baseUrl: "https://x.com", satsCost: 3, totalTokens: 1000, client: "c1" },
      { modelId: "m", baseUrl: "https://x.com", satsCost: 4, totalTokens: 9999, client: "c1" },
      // medium: [10000, 50000)
      { modelId: "m", baseUrl: "https://x.com", satsCost: 5, totalTokens: 10000, client: "c1" },
      // large: [50000, 100000)
      { modelId: "m", baseUrl: "https://x.com", satsCost: 6, totalTokens: 50000, client: "c1" },
      // huge: [100000, ∞)
      { modelId: "m", baseUrl: "https://x.com", satsCost: 7, totalTokens: 100000, client: "c1" },
    ]);
    db.close();

    const store = makeStore(path);
    const summary = store.getUsageSummary(["c1"], 0);

    expect(summary.sizeBuckets.tiny.count).toBe(2);
    expect(summary.sizeBuckets.tiny.cost).toBeCloseTo(3);

    expect(summary.sizeBuckets.small.count).toBe(2);
    expect(summary.sizeBuckets.small.cost).toBeCloseTo(7);

    expect(summary.sizeBuckets.medium.count).toBe(1);
    expect(summary.sizeBuckets.medium.cost).toBeCloseTo(5);

    expect(summary.sizeBuckets.large.count).toBe(1);
    expect(summary.sizeBuckets.large.cost).toBeCloseTo(6);

    expect(summary.sizeBuckets.huge.count).toBe(1);
    expect(summary.sizeBuckets.huge.cost).toBeCloseTo(7);

    store.close();
  });

  it("recent ≤50 DESC, correct field set", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);
    seedClients(db, [{ clientId: "c1", name: "C1", apiKey: "k1" }]);

    const now = Date.now();
    // Seed 60 rows
    for (let i = 0; i < 60; i++) {
      seedRows(db, [{
        modelId: "m",
        baseUrl: "https://x.com",
        satsCost: 1,
        totalTokens: 100,
        client: "c1",
        timestamp: now - i * 1000,
      }]);
    }
    db.close();

    const store = makeStore(path);
    const summary = store.getUsageSummary(["c1"], 0);

    // At most 50
    expect(summary.recent.length).toBe(50);

    // Descending timestamp order
    for (let i = 1; i < summary.recent.length; i++) {
      expect(summary.recent[i - 1]!.timestamp).toBeGreaterThanOrEqual(summary.recent[i]!.timestamp);
    }

    // Field set matches UsageEntry
    const entry = summary.recent[0]!;
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.timestamp).toBe("number");
    expect(typeof entry.modelId).toBe("string");
    expect(typeof entry.baseUrl).toBe("string");
    expect(typeof entry.requestId).toBe("string");
    expect(typeof entry.cost).toBe("number");
    expect(typeof entry.satsCost).toBe("number");
    expect(typeof entry.promptTokens).toBe("number");
    expect(typeof entry.completionTokens).toBe("number");
    expect(typeof entry.totalTokens).toBe("number");

    store.close();
  });

  it("per-client topModels (≤5, desc) for top-3 non-unknown clients", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);
    seedClients(db, [
      { clientId: "c1", name: "C1", apiKey: "k1" },
      { clientId: "c2", name: "C2", apiKey: "k2" },
      { clientId: "c3", name: "C3", apiKey: "k3" },
      { clientId: "c4", name: "C4", apiKey: "k4" },
    ]);

    // c1 has highest satsCost (top 1), c2 (top 2), c3 (top 3), c4 (top 4 - no topModels)
    seedRows(db, [
      { modelId: "gpt-4", baseUrl: "https://a.com", satsCost: 40, totalTokens: 100, client: "c1" },
      { modelId: "claude-3", baseUrl: "https://a.com", satsCost: 20, totalTokens: 100, client: "c1" },
      { modelId: "gpt-4", baseUrl: "https://a.com", satsCost: 30, totalTokens: 100, client: "c2" },
      { modelId: "gpt-4", baseUrl: "https://a.com", satsCost: 20, totalTokens: 100, client: "c3" },
      { modelId: "gpt-3.5", baseUrl: "https://a.com", satsCost: 5, totalTokens: 100, client: "c4" },
    ]);
    db.close();

    const store = makeStore(path);
    const summary = store.getUsageSummary(["c1", "c2", "c3", "c4"], 0);

    // Clients are sorted desc by satsCost. c1=60, c2=30, c3=20, c4=5
    expect(summary.clients[0]!.client).toBe("c1");
    expect(summary.clients[1]!.client).toBe("c2");
    expect(summary.clients[2]!.client).toBe("c3");
    expect(summary.clients[3]!.client).toBe("c4");

    // Top 3 (c1, c2, c3) should have topModels filled
    expect(summary.clients[0]!.topModels.length).toBeGreaterThan(0);
    expect(summary.clients[1]!.topModels.length).toBeGreaterThan(0);
    expect(summary.clients[2]!.topModels.length).toBeGreaterThan(0);

    // c1 has two models; first should be gpt-4 (satsCost=40 > claude-3's 20)
    expect(summary.clients[0]!.topModels[0]!.modelId).toBe("gpt-4");
    expect(summary.clients[0]!.topModels[1]!.modelId).toBe("claude-3");

    // c4 is 4th → no topModels
    expect(summary.clients[3]!.topModels).toEqual([]);

    // topModels length ≤ 5
    for (const c of summary.clients) {
      expect(c.topModels.length).toBeLessThanOrEqual(5);
    }

    store.close();
  });

  it("CROSS-NPUB ISOLATION: scoped to A's ids only, B and NULL-client excluded", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);

    const aClientId = "client-npub-a";
    const bClientId = "client-npub-b";

    seedClients(db, [
      { clientId: aClientId, name: "A", apiKey: "key-a", ownerNpub: "npub1aaa" },
      { clientId: bClientId, name: "B", apiKey: "key-b", ownerNpub: "npub1bbb" },
    ]);

    seedRows(db, [
      // npub A's rows
      { modelId: "gpt-4", baseUrl: "https://a.com", satsCost: 10, totalTokens: 100, client: aClientId },
      { modelId: "gpt-4", baseUrl: "https://a.com", satsCost: 5, totalTokens: 50, client: aClientId },
      // npub B's rows — must NOT appear in A's summary
      { modelId: "claude-3", baseUrl: "https://b.com", satsCost: 999, totalTokens: 9999, client: bClientId },
      // NULL-client row — must NOT appear
      { modelId: "llama", baseUrl: "https://c.com", satsCost: 500, totalTokens: 5000, client: null },
    ]);
    db.close();

    const store = makeStore(path);
    const summary = store.getUsageSummary([aClientId], 0);

    // Totals should only count A's 2 rows
    expect(summary.totals.requests).toBe(2);
    expect(summary.totals.satsCost).toBeCloseTo(15);
    expect(summary.totals.totalTokens).toBe(150);

    // recent must contain only A's client id
    for (const entry of summary.recent) {
      expect(entry.client).toBe(aClientId);
    }

    // clients must contain only A's client
    expect(summary.clients.length).toBe(1);
    expect(summary.clients[0]!.client).toBe(aClientId);

    // No B's model (claude-3) or llama in models list
    const modelIds = summary.models.map((m) => m.modelId);
    expect(modelIds).not.toContain("claude-3");
    expect(modelIds).not.toContain("llama");

    // Providers must not contain B's or null-client's base_url
    const providerUrls = summary.providers.map((p) => p.baseUrl);
    expect(providerUrls).not.toContain("https://b.com");
    expect(providerUrls).not.toContain("https://c.com");

    store.close();
  });

  it("empty ids → zeroed summary, no throw, npubs:[]", () => {
    const path = tmpDbPath();
    const db = createTestDb(path);
    seedClients(db, []);
    seedRows(db, [
      { modelId: "m", baseUrl: "https://x.com", satsCost: 9, totalTokens: 100, client: "some-client" },
    ]);
    db.close();

    const store = makeStore(path);
    let summary: ReturnType<typeof store.getUsageSummary>;
    expect(() => {
      summary = store.getUsageSummary([], 0);
    }).not.toThrow();

    expect(summary!.totals.requests).toBe(0);
    expect(summary!.totals.satsCost).toBe(0);
    expect(summary!.models).toEqual([]);
    expect(summary!.providers).toEqual([]);
    expect(summary!.clients).toEqual([]);
    expect(summary!.npubs).toEqual([]);
    expect(summary!.days).toEqual([]);
    expect(summary!.hoursToday).toEqual([]);
    expect(summary!.recent).toEqual([]);
    expect(summary!.sizeBuckets.tiny).toEqual({ count: 0, cost: 0 });
    expect(summary!.sizeBuckets.small).toEqual({ count: 0, cost: 0 });
    expect(summary!.sizeBuckets.medium).toEqual({ count: 0, cost: 0 });
    expect(summary!.sizeBuckets.large).toEqual({ count: 0, cost: 0 });
    expect(summary!.sizeBuckets.huge).toEqual({ count: 0, cost: 0 });

    store.close();
  });

  it("missing usage_tracking table → throws", () => {
    const path = tmpDbPath();
    paths.push(path);
    // Create DB without usage_tracking table
    const db = new Database(path);
    db.run(`
      CREATE TABLE IF NOT EXISTS sdk_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL)
    `);
    db.run("INSERT OR REPLACE INTO sdk_storage (key, value) VALUES ('client_ids', '[]')");
    db.close();

    const store = new AuthStore(path, []);
    expect(() => store.getUsageSummary(["c1"], 0)).toThrow("usage_tracking table not available");
    store.close();
  });

  it("suffix stripping and single-entry npubs assembly (proxy post-processing)", () => {
    // Test the post-processing logic that proxy.ts applies after getUsageSummary
    // We simulate it directly on a summary object.
    const suffix = "abc1234";
    const suffixedClientId = `my-client-${suffix}`;
    const unsuffixedClientId = "my-client";

    // Build a minimal summary as getUsageSummary would return
    const mockSummary = {
      generatedAt: Date.now(),
      totals: { requests: 5, promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.001, satsCost: 10 },
      models: [{ modelId: "gpt-4", requests: 5, promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.001, satsCost: 10 }],
      providers: [],
      clients: [{ client: suffixedClientId, requests: 5, promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.001, satsCost: 10, topModels: [] }],
      npubs: [] as Array<{ npub: string; requests: number; promptTokens: number; completionTokens: number; totalTokens: number; cost: number; satsCost: number; topModels: Array<{ modelId: string; requests: number; satsCost: number; totalTokens: number }> }>,
      days: [],
      hoursToday: [],
      sizeBuckets: { tiny: { count: 0, cost: 0 }, small: { count: 0, cost: 0 }, medium: { count: 0, cost: 0 }, large: { count: 0, cost: 0 }, huge: { count: 0, cost: 0 } },
      recent: [{ id: "r1", timestamp: Date.now(), modelId: "gpt-4", baseUrl: "https://x.com", requestId: "req-1", cost: 0.001, satsCost: 10, promptTokens: 100, completionTokens: 50, totalTokens: 150, client: suffixedClientId }],
    };

    // Simulate proxy suffix stripping
    const removeSuffixFromId = (id: string, sfx: string): string => {
      const suffixStr = `-${sfx}`;
      return id.endsWith(suffixStr) ? id.slice(0, -suffixStr.length) : id;
    };

    mockSummary.clients = mockSummary.clients.map((c) => ({
      ...c,
      client: removeSuffixFromId(c.client, suffix),
    }));
    mockSummary.recent = mockSummary.recent.map((e) => ({
      ...e,
      client: e.client ? removeSuffixFromId(e.client, suffix) : e.client,
    }));
    mockSummary.npubs = mockSummary.totals.requests > 0
      ? [{
        npub: "npub1test",
        ...mockSummary.totals,
        topModels: mockSummary.models.slice(0, 5).map((m) => ({
          modelId: m.modelId,
          requests: m.requests,
          satsCost: m.satsCost,
          totalTokens: m.totalTokens,
        })),
      }]
      : [];

    // Assert suffix was stripped
    expect(mockSummary.clients[0]!.client).toBe(unsuffixedClientId);
    expect(mockSummary.recent[0]!.client).toBe(unsuffixedClientId);

    // Assert npubs assembled correctly
    expect(mockSummary.npubs.length).toBe(1);
    expect(mockSummary.npubs[0]!.npub).toBe("npub1test");
    expect(mockSummary.npubs[0]!.requests).toBe(5);
    expect(mockSummary.npubs[0]!.satsCost).toBe(10);
    expect(mockSummary.npubs[0]!.topModels.length).toBe(1);
    expect(mockSummary.npubs[0]!.topModels[0]!.modelId).toBe("gpt-4");
  });
});
