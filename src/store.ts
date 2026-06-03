import { Database } from "bun:sqlite";
import { nip19 } from "nostr-tools";

export interface Client {
  clientId: string;
  name: string;
  apiKey: string;
  createdAt: number;
  lastUsed: number | null;
  ownerNpub?: string;
}

export interface UsageEntry {
  id: string;
  timestamp: number;
  modelId: string;
  baseUrl: string;
  requestId: string;
  cost: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  client?: string;
  sessionId?: string;
  tags?: string[];
}

// ─── UsageSummary types (contract-parity with routstrd usage-summary.ts) ─────

export interface StatRow {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  satsCost: number;
}

export interface ModelSummary extends StatRow {
  modelId: string;
}

export interface ProviderSummary extends StatRow {
  baseUrl: string;
}

export interface TopModel {
  modelId: string;
  requests: number;
  satsCost: number;
  totalTokens: number;
}

export interface ClientSummary extends StatRow {
  client: string;
  topModels: TopModel[];
}

export interface NpubSummary extends StatRow {
  npub: string;
  topModels: TopModel[];
}

export interface DaySummary extends StatRow {
  date: string; // "YYYY-MM-DD"
}

export interface HourSummary extends StatRow {
  hour: number; // 0..23
}

export interface SizeBucket {
  count: number;
  cost: number; // summed satsCost
}

export interface UsageSummary {
  generatedAt: number;
  totals: StatRow;
  models: ModelSummary[];
  providers: ProviderSummary[];
  clients: ClientSummary[];
  npubs: NpubSummary[];
  days: DaySummary[];
  hoursToday: HourSummary[];
  sizeBuckets: {
    tiny: SizeBucket;
    small: SizeBucket;
    medium: SizeBucket;
    large: SizeBucket;
    huge: SizeBucket;
  };
  recent: UsageEntry[];
}

export type NpubRole = "admin" | "user";

export interface NpubEntry {
  pubkey: string;
  npub: string;
  createdAt: number;
  createdBy: string | null;
  source: string;
  role: NpubRole;
}

/**
 * Thin wrapper around the shared routstrd SQLite DB.
 *
 * Client API keys are read from routstrd's sdk_storage key-value table.
 * Registered npubs (admin and user) are stored in a dedicated table in the same DB.
 */
export class AuthStore {
  private db: Database;

  constructor(dbPath: string, bootstrapAdminPubkeys: string[] = []) {
    this.db = new Database(dbPath);
    this.migrateNpubTable();
    this.bootstrapAdminPubkeys(bootstrapAdminPubkeys);
  }

  /**
   * Creates the npubs table and migrates legacy admin data if present.
   * Handles the rename from routstr_auth_admins → routstr_auth_npubs with
   * a new `role` column (legacy admins become 'admin' role).
   */
  private migrateNpubTable(): void {
    this.db.transaction(() => {
      // Create the new table.
      this.db.run(`
        CREATE TABLE IF NOT EXISTS routstr_auth_npubs (
          pubkey TEXT PRIMARY KEY,
          npub TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          created_by TEXT,
          source TEXT NOT NULL DEFAULT 'api',
          role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user'))
        )
      `);

      // Check if the legacy table exists and migrate its data.
      const legacyExists = this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='routstr_auth_admins'")
        .get();

      if (legacyExists) {
        this.db.run(`
          INSERT OR IGNORE INTO routstr_auth_npubs (pubkey, npub, created_at, created_by, source, role)
          SELECT pubkey, npub, created_at, created_by, source, 'admin' FROM routstr_auth_admins
        `);
        this.db.run(`DROP TABLE routstr_auth_admins`);
      }
    })();
  }

  private bootstrapAdminPubkeys(pubkeys: string[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO routstr_auth_npubs
        (pubkey, npub, created_at, created_by, source, role)
      VALUES
        (?, ?, ?, NULL, 'env', 'admin')
    `);

    const now = Math.floor(Date.now() / 1000);
    const uniquePubkeys = [...new Set(pubkeys.map((p) => p.toLowerCase()))];
    for (const pubkey of uniquePubkeys) {
      insert.run(pubkey, nip19.npubEncode(pubkey), now);
    }
  }

  /** Read all clients from the sdk_storage JSON blob. */
  getClients(): Client[] {
    const row = this.db
      .query("SELECT value FROM sdk_storage WHERE key = 'client_ids'")
      .get() as { value: string } | null;
    if (!row?.value) return [];
    try {
      return JSON.parse(row.value) as Client[];
    } catch {
      return [];
    }
  }

  private hasTable(tableName: string): boolean {
    const row = this.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) as { name: string } | null;
    return Boolean(row);
  }

  private mapUsageRow(row: Record<string, unknown>): UsageEntry {
    let tags: string[] | undefined;
    if (typeof row.tags === "string") {
      try {
        const parsedTags = JSON.parse(row.tags);
        tags = Array.isArray(parsedTags) ? parsedTags.filter((t) => typeof t === "string") : undefined;
      } catch {
        tags = undefined;
      }
    }

    return {
      id: String(row.id),
      timestamp: Number(row.timestamp),
      modelId: String(row.model_id),
      baseUrl: String(row.base_url),
      requestId: String(row.request_id),
      cost: Number(row.cost),
      satsCost: Number(row.sats_cost),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
      client: typeof row.client === "string" ? row.client : undefined,
      sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
      tags,
    };
  }

  /** Read usage entries for the provided stored client ids directly from SQLite. */
  getUsageByClientIds(clientIds: string[], limit: number): UsageEntry[] {
    const uniqueClientIds = [...new Set(clientIds)].filter(Boolean);
    if (uniqueClientIds.length === 0) return [];

    if (this.hasTable("usage_tracking")) {
      const placeholders = uniqueClientIds.map(() => "?").join(", ");
      const rows = this.db
        .query(`SELECT * FROM usage_tracking WHERE client IN (${placeholders}) ORDER BY timestamp DESC LIMIT ?`)
        .all(...uniqueClientIds, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => this.mapUsageRow(row));
    }

    // Legacy fallback for old SDK storage before usage_tracking had its own table.
    const row = this.db
      .query("SELECT value FROM sdk_storage WHERE key = 'usage_tracking'")
      .get() as { value: string } | null;
    if (!row?.value) return [];

    try {
      const clientIdSet = new Set(uniqueClientIds);
      const entries = JSON.parse(row.value) as UsageEntry[];
      return entries
        .filter((entry) => entry.client && clientIdSet.has(entry.client))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /** Look up a client by their API key. */
  findByApiKey(apiKey: string): Client | null {
    return this.getClients().find((c) => c.apiKey === apiKey) ?? null;
  }

  /** Check if any clients exist (for bootstrap detection). */
  hasAnyClients(): boolean {
    return this.getClients().length > 0;
  }

  listNpubs(role?: NpubRole): NpubEntry[] {
    const where = role ? " WHERE role = ?" : "";
    const params = role ? [role] : [];
    const rows = this.db
      .query(`SELECT pubkey, npub, created_at, created_by, source, role FROM routstr_auth_npubs${where} ORDER BY created_at ASC, npub ASC`)
      .all(...params) as Array<{
        pubkey: string;
        npub: string;
        created_at: number;
        created_by: string | null;
        source: string;
        role: NpubRole;
      }>;

    return rows.map((row) => ({
      pubkey: row.pubkey,
      npub: row.npub,
      createdAt: row.created_at,
      createdBy: row.created_by,
      source: row.source,
      role: row.role,
    }));
  }

  /** @deprecated Use `countNpubs()` or `countNpubs('admin')`. */
  countAdminNpubs(): number {
    return this.countNpubs("admin");
  }

  countNpubs(role?: NpubRole): number {
    const where = role ? " WHERE role = ?" : "";
    const params = role ? [role] : [];
    const row = this.db
      .query(`SELECT COUNT(*) AS count FROM routstr_auth_npubs${where}`)
      .get(...params) as { count: number };
    return row.count;
  }

  /** @deprecated Use `hasNpub(pubkey)` or `hasNpubRole(pubkey, 'admin')`. */
  hasAdminPubkey(pubkey: string): boolean {
    return this.hasNpubRole(pubkey, "admin");
  }

  hasNpub(pubkey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM routstr_auth_npubs WHERE pubkey = ? LIMIT 1")
      .get(pubkey.toLowerCase()) as { 1: number } | null;
    return Boolean(row);
  }

  hasNpubRole(pubkey: string, role: NpubRole): boolean {
    const row = this.db
      .query("SELECT 1 FROM routstr_auth_npubs WHERE pubkey = ? AND role = ? LIMIT 1")
      .get(pubkey.toLowerCase(), role) as { 1: number } | null;
    return Boolean(row);
  }

  getNpubByPubkey(pubkey: string): NpubEntry | undefined {
    const row = this.db
      .query("SELECT pubkey, npub, created_at, created_by, source, role FROM routstr_auth_npubs WHERE pubkey = ?")
      .get(pubkey.toLowerCase()) as {
        pubkey: string;
        npub: string;
        created_at: number;
        created_by: string | null;
        source: string;
        role: NpubRole;
      } | null;

    if (!row) return undefined;
    return {
      pubkey: row.pubkey,
      npub: row.npub,
      createdAt: row.created_at,
      createdBy: row.created_by,
      source: row.source,
      role: row.role,
    };
  }

  addNpub(pubkey: string, role: NpubRole = "admin", createdBy: string | null = null): NpubEntry & { added: boolean } {
    const normalizedPubkey = pubkey.toLowerCase();
    const npub = nip19.npubEncode(normalizedPubkey);
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO routstr_auth_npubs
          (pubkey, npub, created_at, created_by, source, role)
        VALUES
          (?, ?, ?, ?, 'api', ?)
      `)
      .run(normalizedPubkey, npub, now, createdBy?.toLowerCase() ?? null, role);

    const row = this.db
      .query("SELECT pubkey, npub, created_at, created_by, source, role FROM routstr_auth_npubs WHERE pubkey = ?")
      .get(normalizedPubkey) as {
        pubkey: string;
        npub: string;
        created_at: number;
        created_by: string | null;
        source: string;
        role: NpubRole;
      };

    return {
      pubkey: row.pubkey,
      npub: row.npub,
      createdAt: row.created_at,
      createdBy: row.created_by,
      source: row.source,
      role: row.role,
      added: result.changes > 0,
    };
  }

  /** @deprecated Use `addNpub(pubkey, 'admin', createdBy)`. */
  addAdminPubkey(pubkey: string, createdBy: string | null = null): NpubEntry & { added: boolean } {
    return this.addNpub(pubkey, "admin", createdBy);
  }

  updateNpubRole(pubkey: string, role: NpubRole): NpubEntry | null {
    const normalizedPubkey = pubkey.toLowerCase();
    const existing = this.getNpubByPubkey(normalizedPubkey);
    if (!existing) return null;

    this.db
      .prepare("UPDATE routstr_auth_npubs SET role = ? WHERE pubkey = ?")
      .run(role, normalizedPubkey);

    return this.getNpubByPubkey(normalizedPubkey)!;
  }

  removeNpub(pubkey: string): boolean {
    const result = this.db
      .prepare("DELETE FROM routstr_auth_npubs WHERE pubkey = ?")
      .run(pubkey.toLowerCase());
    return result.changes > 0;
  }

  /** @deprecated Use `removeNpub(pubkey)`. */
  removeAdminPubkey(pubkey: string): boolean {
    return this.removeNpub(pubkey);
  }

  // ─── Usage summary ─────────────────────────────────────────────────────────

  /**
   * Build a UsageSummary scoped to the given stored client ids.
   *
   * Throws if the `usage_tracking` table does not exist (legacy DB), so the
   * proxy can catch and return a 500 that causes the monitor to fall back to
   * the legacy `/usage` endpoint.
   *
   * Returns a fully-zeroed summary immediately when `clientIds` is empty —
   * never emits `client IN ()`.
   */
  getUsageSummary(clientIds: string[], tzOffsetMinutes: number): UsageSummary {
    const ids = [...new Set(clientIds)].filter(Boolean);

    if (!this.hasTable("usage_tracking")) {
      throw new Error("usage_tracking table not available");
    }

    const now = Date.now();

    if (ids.length === 0) {
      return {
        generatedAt: now,
        totals: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, satsCost: 0 },
        models: [],
        providers: [],
        clients: [],
        npubs: [],
        days: [],
        hoursToday: [],
        sizeBuckets: {
          tiny: { count: 0, cost: 0 },
          small: { count: 0, cost: 0 },
          medium: { count: 0, cost: 0 },
          large: { count: 0, cost: 0 },
          huge: { count: 0, cost: 0 },
        },
        recent: [],
      };
    }

    const ph = ids.map(() => "?").join(", ");

    const AGGS = `
      COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens),0) AS promptTokens,
      COALESCE(SUM(completion_tokens),0) AS completionTokens,
      COALESCE(SUM(total_tokens),0) AS totalTokens,
      COALESCE(SUM(cost),0) AS cost,
      COALESCE(SUM(sats_cost),0) AS satsCost
    `;

    type AggRow = {
      grp: string | null;
      requests: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cost: number;
      satsCost: number;
    };

    const mapAggRow = (row: Record<string, unknown>) => ({
      grp: row.grp == null ? null : String(row.grp),
      requests: Number(row.requests),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      totalTokens: Number(row.totalTokens),
      cost: Number(row.cost),
      satsCost: Number(row.satsCost),
    });

    const toStat = (r: AggRow): StatRow => ({
      requests: r.requests,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      cost: r.cost,
      satsCost: r.satsCost,
    });

    // 1. Totals
    const totalsRaw = this.db
      .query(`SELECT NULL AS grp, ${AGGS} FROM usage_tracking WHERE client IN (${ph})`)
      .all(...ids) as Array<Record<string, unknown>>;
    const totalsRow = mapAggRow(totalsRaw[0] ?? {});
    const totals: StatRow = toStat(totalsRow);

    // 2. Models (desc by satsCost)
    const modelRaws = this.db
      .query(`SELECT model_id AS grp, ${AGGS} FROM usage_tracking WHERE client IN (${ph}) GROUP BY grp ORDER BY satsCost DESC`)
      .all(...ids) as Array<Record<string, unknown>>;
    const models: ModelSummary[] = modelRaws.map(mapAggRow).map((r) => ({
      modelId: r.grp ?? "unknown",
      ...toStat(r),
    }));

    // 3. Providers (desc by satsCost)
    const providerRaws = this.db
      .query(`SELECT base_url AS grp, ${AGGS} FROM usage_tracking WHERE client IN (${ph}) GROUP BY grp ORDER BY satsCost DESC`)
      .all(...ids) as Array<Record<string, unknown>>;
    const providers: ProviderSummary[] = providerRaws.map(mapAggRow).map((r) => ({
      baseUrl: r.grp ?? "unknown",
      ...toStat(r),
    }));

    // 4. Clients (desc by satsCost)
    const clientRaws = this.db
      .query(`SELECT client AS grp, ${AGGS} FROM usage_tracking WHERE client IN (${ph}) GROUP BY grp ORDER BY satsCost DESC`)
      .all(...ids) as Array<Record<string, unknown>>;
    const clientAggRows = clientRaws.map(mapAggRow);
    const clientSummaries: ClientSummary[] = clientAggRows.map((r) => ({
      client: r.grp ?? "unknown",
      ...toStat(r),
      topModels: [],
    }));

    // 5. Per-client topModels for top 3 non-"unknown" clients
    const topClientRows = clientAggRows.filter((r) => r.grp !== null).slice(0, 3);
    for (const clientRow of topClientRows) {
      const clientId = clientRow.grp!;
      const topModelRaws = this.db
        .query(`SELECT model_id AS grp, ${AGGS} FROM usage_tracking WHERE client = ? GROUP BY grp ORDER BY satsCost DESC`)
        .all(clientId) as Array<Record<string, unknown>>;
      const topModels: TopModel[] = topModelRaws.map(mapAggRow).slice(0, 5).map((r) => ({
        modelId: r.grp ?? "unknown",
        requests: r.requests,
        satsCost: r.satsCost,
        totalTokens: r.totalTokens,
      }));
      const summary = clientSummaries.find((c) => c.client === clientId);
      if (summary) {
        summary.topModels = topModels;
      }
    }

    // 6. Days (last 30, local time, most-recent-first)
    const after30d = now - 30 * 86400000;
    const dayRaws = this.db
      .query(`SELECT strftime('%Y-%m-%d', (timestamp - ? * 60000)/1000, 'unixepoch') AS grp, ${AGGS} FROM usage_tracking WHERE timestamp > ? AND client IN (${ph}) GROUP BY grp ORDER BY grp ASC`)
      .all(tzOffsetMinutes, after30d, ...ids) as Array<Record<string, unknown>>;
    const days: DaySummary[] = dayRaws.map(mapAggRow).map((r) => ({
      date: r.grp ?? "",
      ...toStat(r),
    })).reverse();

    // 7. Hours today (local time, ascending)
    const todayStartUtc = Math.floor((now - tzOffsetMinutes * 60000) / 86400000) * 86400000 + tzOffsetMinutes * 60000;
    const hourRaws = this.db
      .query(`SELECT strftime('%H', (timestamp - ? * 60000)/1000, 'unixepoch') AS grp, ${AGGS} FROM usage_tracking WHERE timestamp > ? AND client IN (${ph}) GROUP BY grp ORDER BY grp ASC`)
      .all(tzOffsetMinutes, todayStartUtc - 1, ...ids) as Array<Record<string, unknown>>;
    const hoursToday: HourSummary[] = hourRaws.map(mapAggRow).map((r) => ({
      hour: Number(r.grp),
      ...toStat(r),
    }));

    // 8. Size buckets (half-open [min,max))
    const bucketQuery = (minTokens: number, maxTokens?: number): SizeBucket => {
      const maxClause = maxTokens !== undefined ? ` AND total_tokens < ?` : "";
      const args: unknown[] = maxTokens !== undefined
        ? [...ids, minTokens, maxTokens]
        : [...ids, minTokens];
      const rows = this.db
        .query(`SELECT NULL AS grp, ${AGGS} FROM usage_tracking WHERE client IN (${ph}) AND total_tokens >= ?${maxClause}`)
        .all(...args) as Array<Record<string, unknown>>;
      const r = mapAggRow(rows[0] ?? {});
      return { count: r.requests, cost: r.satsCost };
    };

    const sizeBuckets = {
      tiny: bucketQuery(0, 1000),
      small: bucketQuery(1000, 10000),
      medium: bucketQuery(10000, 50000),
      large: bucketQuery(50000, 100000),
      huge: bucketQuery(100000),
    };

    // 9. Recent (latest 50, raw client ids — proxy strips suffixes)
    const recentRaws = this.db
      .query(`SELECT * FROM usage_tracking WHERE client IN (${ph}) ORDER BY timestamp DESC LIMIT 50`)
      .all(...ids) as Array<Record<string, unknown>>;
    const recent: UsageEntry[] = recentRaws.map((row) => this.mapUsageRow(row));

    return {
      generatedAt: now,
      totals,
      models,
      providers,
      clients: clientSummaries,
      npubs: [], // filled by proxy
      days,
      hoursToday,
      sizeBuckets,
      recent,
    };
  }

  close(): void {
    this.db.close();
  }
}
