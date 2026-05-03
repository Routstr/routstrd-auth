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

  close(): void {
    this.db.close();
  }
}
