import type { AuthProxyConfig } from "./config";
import { AuthStore } from "./store";

/**
 * Thin proxy that validates Bearer tokens and forwards requests
 * to the routstrd daemon running on localhost only.
 */
export class AuthProxy {
  private config: AuthProxyConfig;
  private store: AuthStore;

  constructor(config: AuthProxyConfig) {
    this.config = config;
    this.store = new AuthStore(config.dbPath);
  }

  /** Check whether the clients table is empty (bootstrap mode). */
  private hasClients(): boolean {
    return this.store.hasAnyClients();
  }

  /**
   * Forward a request to the upstream routstrd daemon.
   * Optionally injects an x-routstr-client-id header.
   */
  private async forward(req: Request, clientId?: string): Promise<Response> {
    const url = new URL(req.url);
    const upstreamUrl = `${this.config.upstream}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    // Strip auth header before forwarding — the daemon doesn't need it.
    headers.delete("authorization");
    headers.delete("host");
    // Inject client identity if available.
    if (clientId) {
      headers.set("x-routstr-client-id", clientId);
    }

    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : req.body;

    try {
      return await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
      });
    } catch {
      return new Response("Upstream unreachable", { status: 502 });
    }
  }

  /** Handle a single incoming request. */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const authorization = req.headers.get("authorization");

    const hasAny = this.hasClients();
    const isPublicPath = AuthProxy.PUBLIC_PATHS.has(path) ||
      AuthProxy.PUBLIC_PREFIXES.some((p) => path.startsWith(p));

    // --- Public path: forward immediately ---
    if (isPublicPath) {
      return this.forward(req);
    }

    // --- Bootstrap: POST /clients/add with no clients yet ---
    if (path === "/clients/add" && !hasAny) {
      return this.forward(req);
    }

    // --- Auth required ---
    if (!authorization) {
      return new Response(
        JSON.stringify({
          error:
            "Missing Authorization header. " +
            "Use 'Authorization: Bearer sk-...' or set ROUTSTRD_API_KEY.",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch) {
      return new Response(
        JSON.stringify({
          error: "Invalid Authorization format. Expected 'Bearer sk-...'.",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const apiKey = bearerMatch[1]!;
    const client = this.store.findByApiKey(apiKey);
    if (!client) {
      return new Response(
        JSON.stringify({ error: "Invalid API key." }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return this.forward(req, client.clientId);
  }

  /** Start the Bun HTTP server. */
  serve() {
    const { port, host } = this.config;
    console.log(`routstrd-auth proxy listening on http://${host}:${port}`);
    console.log(`  Upstream: ${this.config.upstream}`);
    console.log(`  DB path:  ${this.config.dbPath}`);

    Bun.serve({
      port,
      hostname: host,
      fetch: (req) => this.handle(req),
    });

    // Graceful shutdown.
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      this.store.close();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      this.store.close();
      process.exit(0);
    });
  }

  // --- Exported for testing / external use ---

  close(): void {
    this.store.close();
  }

  /** Public endpoints that don't require auth. */
  static PUBLIC_PATHS = new Set([
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

  /** Public path prefixes. */
  static PUBLIC_PREFIXES = ["/models/", "/wallet/"];
}