import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuthStore } from "./store";

// The hardcoded admin npub docker-entrypoint.sh used to default to.
const LEGACY_DEFAULT_ADMIN_PUBKEY =
  "fc76f8bdeeafc37a5a499b3a24064774d8a5a02c299a64aca072cf8c6c827b1f";
const ENV_ADMIN_A = "ab".repeat(32);
const ENV_ADMIN_B = "cd".repeat(32);
const API_NPUB = "ef".repeat(32);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-auth-store-test-"));
  tmpDirs.push(dir);
  return join(dir, "test.db");
}

describe("AuthStore env admin reconciliation", () => {
  it("bootstraps env admin pubkeys with source='env'", () => {
    const store = new AuthStore(tmpDbPath(), [ENV_ADMIN_A, ENV_ADMIN_B]);
    const npubs = store.listNpubs();
    expect(npubs.map((n) => n.pubkey).sort()).toEqual(
      [ENV_ADMIN_A, ENV_ADMIN_B].sort(),
    );
    for (const n of npubs) {
      expect(n.source).toBe("env");
      expect(n.role).toBe("admin");
    }
    store.close();
  });

  it("removes env-sourced npubs that are no longer in the env var", () => {
    const dbPath = tmpDbPath();
    new AuthStore(dbPath, [ENV_ADMIN_A, ENV_ADMIN_B]).close();

    const store = new AuthStore(dbPath, [ENV_ADMIN_A]);
    expect(store.hasNpub(ENV_ADMIN_A)).toBe(true);
    expect(store.hasNpub(ENV_ADMIN_B)).toBe(false);
    store.close();
  });

  it("purges the legacy hardcoded default admin when the env var is unset", () => {
    // Simulate an install that booted with the old baked-in default.
    const dbPath = tmpDbPath();
    new AuthStore(dbPath, [LEGACY_DEFAULT_ADMIN_PUBKEY]).close();

    const store = new AuthStore(dbPath, []);
    expect(store.hasNpub(LEGACY_DEFAULT_ADMIN_PUBKEY)).toBe(false);
    expect(store.countNpubs()).toBe(0);
    store.close();
  });

  it("never removes npubs registered via the API", () => {
    const dbPath = tmpDbPath();
    const first = new AuthStore(dbPath, [ENV_ADMIN_A]);
    first.addNpub(API_NPUB, "user", ENV_ADMIN_A);
    first.close();

    // Env var now unset: env row goes, API row stays.
    const store = new AuthStore(dbPath, []);
    expect(store.hasNpub(ENV_ADMIN_A)).toBe(false);
    const apiEntry = store.getNpubByPubkey(API_NPUB);
    expect(apiEntry?.source).toBe("api");
    expect(apiEntry?.role).toBe("user");
    store.close();
  });

  it("is case-insensitive when matching env pubkeys against stored rows", () => {
    const dbPath = tmpDbPath();
    new AuthStore(dbPath, [ENV_ADMIN_A.toLowerCase()]).close();

    const store = new AuthStore(dbPath, [ENV_ADMIN_A.toUpperCase()]);
    expect(store.hasNpub(ENV_ADMIN_A)).toBe(true);
    expect(store.countNpubs()).toBe(1);
    store.close();
  });
});

// Usage summary forwarding tests:
// The auth proxy now forwards /usage and /usage/summary directly to the
// routstrd daemon with ?npub=<npub>. The daemon handles filtering, suffix
// stripping, and the full summary shape. Tests for getUsageSummary were
// removed from here — they live in the routstrd daemon's test suite.
