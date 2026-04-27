import { Database } from "bun:sqlite";
import { nip19 } from "nostr-tools";

export interface Client {
  clientId: string;
  name: string;
  apiKey: string;
  createdAt: number;
  lastUsed: number | null;
}

export interface AdminNpub {
  pubkey: string;
  npub: string;
  createdAt: number;
  createdBy: string | null;
  source: string;
}

/**
 * Thin wrapper around the shared routstrd SQLite DB.
 *
 * Client API keys are read from routstrd's sdk_storage key-value table. Admin
 * npubs for this auth proxy are stored in a dedicated table in the same DB.
 */
export class AuthStore {
  private db: Database;

  constructor(dbPath: string, bootstrapAdminPubkeys: string[] = []) {
    this.db = new Database(dbPath);
    this.ensureAdminTable();
    this.bootstrapAdminPubkeys(bootstrapAdminPubkeys);
  }

  private ensureAdminTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS routstr_auth_admins (
        pubkey TEXT PRIMARY KEY,
        npub TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        source TEXT NOT NULL DEFAULT 'api'
      )
    `);
  }

  private bootstrapAdminPubkeys(pubkeys: string[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO routstr_auth_admins
        (pubkey, npub, created_at, created_by, source)
      VALUES
        (?, ?, ?, NULL, 'env')
    `);

    const now = Math.floor(Date.now() / 1000);
    const uniquePubkeys = [...new Set(pubkeys.map((p) => p.toLowerCase()))];
    for (const pubkey of uniquePubkeys) {
      insert.run(pubkey, nip19.npubEncode(pubkey), now);
    }
  }

  /** Read all clients from the sdk_storage JSON blob. */
  private getClients(): Client[] {
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

  listAdminNpubs(): AdminNpub[] {
    const rows = this.db
      .query("SELECT pubkey, npub, created_at, created_by, source FROM routstr_auth_admins ORDER BY created_at ASC, npub ASC")
      .all() as Array<{
        pubkey: string;
        npub: string;
        created_at: number;
        created_by: string | null;
        source: string;
      }>;

    return rows.map((row) => ({
      pubkey: row.pubkey,
      npub: row.npub,
      createdAt: row.created_at,
      createdBy: row.created_by,
      source: row.source,
    }));
  }

  countAdminNpubs(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM routstr_auth_admins")
      .get() as { count: number };
    return row.count;
  }

  hasAdminPubkey(pubkey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM routstr_auth_admins WHERE pubkey = ? LIMIT 1")
      .get(pubkey.toLowerCase()) as { 1: number } | null;
    return Boolean(row);
  }

  addAdminPubkey(pubkey: string, createdBy: string | null = null): AdminNpub & { added: boolean } {
    const normalizedPubkey = pubkey.toLowerCase();
    const npub = nip19.npubEncode(normalizedPubkey);
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO routstr_auth_admins
          (pubkey, npub, created_at, created_by, source)
        VALUES
          (?, ?, ?, ?, 'api')
      `)
      .run(normalizedPubkey, npub, now, createdBy?.toLowerCase() ?? null);

    const row = this.db
      .query("SELECT pubkey, npub, created_at, created_by, source FROM routstr_auth_admins WHERE pubkey = ?")
      .get(normalizedPubkey) as {
        pubkey: string;
        npub: string;
        created_at: number;
        created_by: string | null;
        source: string;
      };

    return {
      pubkey: row.pubkey,
      npub: row.npub,
      createdAt: row.created_at,
      createdBy: row.created_by,
      source: row.source,
      added: result.changes > 0,
    };
  }

  removeAdminPubkey(pubkey: string): boolean {
    const result = this.db
      .prepare("DELETE FROM routstr_auth_admins WHERE pubkey = ?")
      .run(pubkey.toLowerCase());
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
