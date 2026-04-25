import { Database } from "bun:sqlite";

export interface Client {
  clientId: string;
  name: string;
  apiKey: string;
  createdAt: number;
  lastUsed: number | null;
}

/**
 * Thin wrapper around the shared routstrd SQLite DB (sdk_storage key-value table).
 * Only performs read-only operations for auth validation.
 */
export class AuthStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
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

  close(): void {
    this.db.close();
  }
}
