import { join } from "path";
import { existsSync } from "fs";

const HOME = process.env.HOME || process.env.USERPROFILE || "";

/** Directory for routstr config (shared with routstrd). */
export const ROUTSTRD_DIR =
  process.env.ROUTSTRD_DIR || join(HOME, ".routstrd");

/** Path to the shared SQLite database. */
export const DB_PATH =
  process.env.ROUTSTRD_DB_PATH || join(ROUTSTRD_DIR, "routstr.db");

/** Path to the config file (JSON, routstrd-compatible). */
export const CONFIG_FILE =
  process.env.ROUTSTRD_CONFIG_FILE || join(ROUTSTRD_DIR, "config.json");

/** Default public port (clients connect here). */
export const DEFAULT_PORT = Number(process.env.ROUTSTRD_AUTH_PORT) || 8008;

/** Default upstream (routstrd daemon) — must be local-only. */
export const DEFAULT_UPSTREAM =
  process.env.ROUTSTRD_UPSTREAM || "http://localhost:8008";

/** Default host for the auth proxy. */
export const DEFAULT_HOST = process.env.ROUTSTRD_AUTH_HOST || "0.0.0.0";

export interface AuthProxyConfig {
  /** Public port to listen on. */
  port: number;
  /** Host to bind. */
  host: string;
  /** Upstream routstrd daemon URL. */
  upstream: string;
  /** Path to the shared SQLite DB. */
  dbPath: string;
  /** Optional: path to a JSON config file for bootstrapping. */
  configFile: string;
}

/**
 * Load configuration with env-var overrides.
 */
export function loadConfig(): AuthProxyConfig {
  const config: AuthProxyConfig = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    upstream: DEFAULT_UPSTREAM,
    dbPath: DB_PATH,
    configFile: CONFIG_FILE,
  };

  return config;
}

/**
 * Validate that the DB file exists, returning a human-friendly error if not.
 */
export function validateConfig(cfg: AuthProxyConfig): string | null {
  if (!existsSync(cfg.dbPath)) {
    return `Database not found at ${cfg.dbPath}. Make sure routstrd has been initialized (routstrd onboard).`;
  }
  return null;
}