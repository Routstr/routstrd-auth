import type { AuthProxyConfig } from "./config";
import { validateNIP98Request } from "./nip98";
import { AuthStore } from "./store";

/**
 * Thin proxy that validates Bearer tokens or NIP-98 Nostr HTTP auth events and
 * forwards requests to the routstrd daemon running on localhost only.
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
   * Optionally injects client identity headers.
   */
  private async forward(
    req: Request,
    identity?: { clientId?: string; nostrPubkey?: string },
    body?: Uint8Array,
  ): Promise<Response> {
    const url = new URL(req.url);
    const upstreamUrl = `${this.config.upstream}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    // Strip auth header before forwarding — the daemon doesn't need it.
    headers.delete("authorization");
    headers.delete("host");
    // Inject client identity if available.
    if (identity?.clientId) {
      headers.set("x-routstr-client-id", identity.clientId);
    }
    if (identity?.nostrPubkey) {
      headers.set("x-routstr-nostr-pubkey", identity.nostrPubkey);
      // Also set x-routstr-client-id so existing upstream code that keys off a
      // single client-id header can identify NIP-98 users without changes.
      headers.set("x-routstr-client-id", `nostr:${identity.nostrPubkey}`);
    }

    const requestBody =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : body ?? req.body;

    try {
      return await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: requestBody,
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

    const isPublicPath = AuthProxy.isPublicPath(path);

    // --- Public path: forward immediately ---
    if (isPublicPath) {
      return this.forward(req);
    }

    // --- Auth required ---
    if (!authorization) {
      return new Response(
        JSON.stringify({
          error:
            "Missing Authorization header. " +
            "Use 'Authorization: Bearer sk-...' or 'Authorization: Nostr <base64-event>'.",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      if (AuthProxy.isAdminPath(path)) {
        return new Response(
          JSON.stringify({
            error:
              "This endpoint requires NIP-98 auth from a configured admin npub/pubkey.",
          }),
          {
            status: 403,
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

      return this.forward(req, { clientId: client.clientId });
    }

    const nip98Match = authorization.match(/^Nostr\s+(.+)$/i);
    if (nip98Match) {
      // The request body stream can be consumed only once. Buffer it so NIP-98
      // can verify the payload hash and the same bytes can still be forwarded.
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : new Uint8Array(await req.arrayBuffer());

      try {
        const { pubkey } = await validateNIP98Request(authorization, req, body);

        if (AuthProxy.isAdminPath(path) && !this.isAdminPubkey(pubkey)) {
          return new Response(
            JSON.stringify({
              error: this.config.adminPubkeys.length === 0
                ? "This endpoint requires an admin npub/pubkey, but none is configured. Set ROUTSTRD_AUTH_ADMIN_NPUBS or ROUTSTRD_AUTH_ADMIN_PUBKEYS."
                : "This endpoint requires NIP-98 auth from a configured admin npub/pubkey.",
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return this.forward(req, { nostrPubkey: pubkey }, body);
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : "Invalid NIP-98 token.",
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    return new Response(
      JSON.stringify({
        error:
          "Invalid Authorization format. Expected 'Bearer sk-...' or 'Nostr <base64-event>'.",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  /** Start the Bun HTTP server. */
  serve() {
    const { port, host } = this.config;
    console.log(`routstrd-auth proxy listening on http://${host}:${port}`);
    console.log(`  Upstream: ${this.config.upstream}`);
    console.log(`  DB path:  ${this.config.dbPath}`);
    console.log(`  Admin npubs/pubkeys: ${this.config.adminPubkeys.length}`);
    if (this.config.adminPubkeys.length === 0) {
      console.warn(
        "  Warning: no admin npub/pubkey configured; /clients/add is disabled. " +
          "Set ROUTSTRD_AUTH_ADMIN_NPUBS or ROUTSTRD_AUTH_ADMIN_PUBKEYS.",
      );
    }

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

  private isAdminPubkey(pubkey: string): boolean {
    return this.config.adminPubkeys.includes(pubkey.toLowerCase());
  }

  /** Minimal public endpoints that don't require auth. */
  static PUBLIC_PATHS = new Set([
    "/health",
    "/ping",
    "/models",
    "/v1/models",
  ]);

  /** Public path prefixes. */
  static PUBLIC_PREFIXES = ["/models/", "/v1/models/"];

  /** Endpoints that require an admin NIP-98 identity, not just any auth. */
  static ADMIN_PATHS = new Set([
    "/clients/add",
  ]);

  static isPublicPath(path: string): boolean {
    if (AuthProxy.PUBLIC_PATHS.has(path)) return true;
    return AuthProxy.PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
  }

  static isAdminPath(path: string): boolean {
    return AuthProxy.ADMIN_PATHS.has(path);
  }
}
