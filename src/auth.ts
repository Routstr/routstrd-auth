import type { Client } from "./store";

/**
 * Public endpoints that don't require auth.
 * Matches routstrd's public endpoints exactly.
 */
const PUBLIC_PATHS = new Set([
  "/health",
  "/ping",
  "/status",
  "/wallet/status",
  "/wallet/balance",
  "/wallet/mints",
  "/models",
  "/v1/models",
  "/balance",
  "/keys/balance",
  "/providers",
  "/usage",
  "/usagePi",
]);

/** Endpoints with the `/models/` prefix. */
const PUBLIC_PREFIXES = ["/models/", "/wallet/"];

export interface AuthResult {
  authenticated: boolean;
  client?: Client;
  // If true, the path is public and no auth is needed.
  isPublicPath: boolean;
}

/**
 * Determine if a path needs auth and validate the Bearer token.
 */
export function authenticate(
  authorization: string | null,
  path: string,
  hasClients: boolean,
  findClient: (apiKey: string) => Client | null,
): AuthResult {
  // Check if the path is public.
  if (PUBLIC_PATHS.has(path)) {
    return { authenticated: true, isPublicPath: true };
  }

  for (const prefix of PUBLIC_PREFIXES) {
    if (path.startsWith(prefix)) {
      return { authenticated: true, isPublicPath: true };
    }
  }

  // Bootstrap: POST /clients/add is allowed with no auth when no clients exist.
  if (path === "/clients/add" && !hasClients) {
    return { authenticated: true, isPublicPath: false };
  }

  // --- Auth required from here ---

  if (!authorization) {
    return { authenticated: false, isPublicPath: false };
  }

  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    return { authenticated: false, isPublicPath: false };
  }

  const apiKey = bearerMatch[1]!;
  const client = findClient(apiKey);
  if (!client) {
    return { authenticated: false, isPublicPath: false };
  }

  return { authenticated: true, isPublicPath: false, client };
}