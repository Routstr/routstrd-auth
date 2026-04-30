import { normalizeNostrPubkey, type AuthProxyConfig } from "./config";
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
    this.store = new AuthStore(config.dbPath, config.adminPubkeys);
  }

  /**
   * Forward a request to the upstream routstrd daemon.
   * @param stripAuth - If true (default), removes the Authorization header before forwarding.
   *                    Pass false to keep the auth header (used for Bearer/sauth tokens).
   */
  private async forward(
    req: Request,
    body?: Uint8Array,
    stripAuth = true,
  ): Promise<Response> {
    const url = new URL(req.url);
    const upstreamUrl = `${this.config.upstream}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    if (stripAuth) {
      headers.delete("authorization");
    }
    headers.delete("host");

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

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private parseNpubBody(body: Uint8Array): string | Response {
    if (body.byteLength === 0) {
      return this.json({ error: "Request body is required. Provide { \"npub\": \"npub1...\" } or { \"pubkey\": \"<64-char hex>\" }." }, 400);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return this.json({ error: "Invalid JSON body." }, 400);
    }

    const value = typeof parsed === "string"
      ? parsed
      : parsed && typeof parsed === "object"
        ? (parsed as { npub?: unknown; pubkey?: unknown }).npub ??
          (parsed as { npub?: unknown; pubkey?: unknown }).pubkey
        : null;

    if (typeof value !== "string") {
      return this.json({ error: "Body must include an npub or pubkey string." }, 400);
    }

    const pubkey = normalizeNostrPubkey(value);
    if (!pubkey) {
      return this.json({ error: "Invalid npub/pubkey. Use npub or 64-char hex pubkey." }, 400);
    }

    return pubkey;
  }

  private async authenticateAdminNip98(
    req: Request,
    authorization: string | null,
    body?: Uint8Array,
  ): Promise<{ pubkey: string } | Response> {
    if (!authorization) {
      return this.json({
        error:
          "Missing Authorization header. This endpoint requires NIP-98 auth from a configured admin npub/pubkey.",
      }, 401);
    }

    if (authorization.match(/^Bearer\s+(.+)$/i)) {
      return this.json({
        error: "This endpoint requires NIP-98 auth from a configured admin npub/pubkey.",
      }, 403);
    }

    if (!authorization.match(/^Nostr\s+(.+)$/i)) {
      return this.json({
        error: "Invalid Authorization format. Expected 'Nostr <base64-event>'.",
      }, 401);
    }

    try {
      const { pubkey } = await validateNIP98Request(authorization, req, body);
      if (!this.isAdminPubkey(pubkey)) {
        return this.json({
          error: this.store.countAdminNpubs() === 0
            ? "This endpoint requires an admin npub/pubkey, but none is configured. Add the first admin with 'routstrd npubs register'."
            : "This endpoint requires NIP-98 auth from a configured admin npub/pubkey.",
        }, 403);
      }

      return { pubkey };
    } catch (err) {
      return this.json({
        error: err instanceof Error ? err.message : "Invalid NIP-98 token.",
      }, 401);
    }
  }

  private async handleNpubs(req: Request, path: string): Promise<Response> {
    if (req.method === "GET" && path === "/npubs") {
      return this.json({ npubs: this.store.listAdminNpubs().map((admin) => admin.npub) });
    }

    if (req.method === "POST" && path === "/npubs") {
      const body = new Uint8Array(await req.arrayBuffer());
      const hasAdmins = this.store.countAdminNpubs() > 0;
      let createdBy: string | null = null;

      if (hasAdmins) {
        const auth = await this.authenticateAdminNip98(
          req,
          req.headers.get("authorization"),
          body,
        );
        if (auth instanceof Response) return auth;
        createdBy = auth.pubkey;
      }

      const pubkey = this.parseNpubBody(body);
      if (pubkey instanceof Response) return pubkey;

      const admin = this.store.addAdminPubkey(pubkey, createdBy);
      return this.json({
        npub: admin.npub,
        pubkey: admin.pubkey,
        added: admin.added,
      }, admin.added ? 201 : 200);
    }

    if (req.method === "DELETE" && (path === "/npubs" || path.startsWith("/npubs/"))) {
      const body = req.method === "GET" || req.method === "HEAD"
        ? undefined
        : new Uint8Array(await req.arrayBuffer());
      const auth = await this.authenticateAdminNip98(
        req,
        req.headers.get("authorization"),
        body,
      );
      if (auth instanceof Response) return auth;

      const url = new URL(req.url);
      const rawValue = path.startsWith("/npubs/")
        ? decodeURIComponent(path.slice("/npubs/".length))
        : url.searchParams.get("npub") ?? url.searchParams.get("pubkey");

      let pubkey: string | Response | null = rawValue
        ? normalizeNostrPubkey(rawValue)
        : null;

      if (!pubkey && body && body.byteLength > 0) {
        pubkey = this.parseNpubBody(body);
        if (pubkey instanceof Response) return pubkey;
      }

      if (!pubkey) {
        return this.json({ error: "Provide the admin to remove in /npubs/<npub>, ?npub=..., or the JSON body." }, 400);
      }

      const removed = this.store.removeAdminPubkey(pubkey);
      return this.json({ removed });
    }

    return this.json({ error: "Not found." }, 404);
  }

  /** Handle a single incoming request. */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const authorization = req.headers.get("authorization");

    if (path === "/npubs" || path.startsWith("/npubs/")) {
      return this.handleNpubs(req, path);
    }

    const isPublicPath = AuthProxy.isPublicPath(path);

    // --- Public path: forward immediately ---
    if (isPublicPath) {
      return this.forward(req);
    }

    // --- Auth required ---
    if (!authorization) {
      return this.json({
        error:
          "Missing Authorization header. " +
          "Use 'Authorization: Bearer sk-...' or 'Authorization: Nostr <base64-event>'.",
      }, 401);
    }

    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      if (AuthProxy.isAdminPath(path)) {
        return this.json({
          error:
            "This endpoint requires NIP-98 auth from a configured admin npub/pubkey.",
        }, 403);
      }

      const apiKey = bearerMatch[1]!;
      const client = this.store.findByApiKey(apiKey);
      if (!client) {
        return this.json({ error: "Invalid API key." }, 401);
      }

      // Keep auth header for Bearer tokens so upstream can validate.
      return this.forward(req, undefined, false);
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

        if (!this.isAdminPubkey(pubkey)) {
          return this.json({
            error: this.store.countAdminNpubs() === 0
              ? "This endpoint requires an admin npub/pubkey, but none is configured. Add the first admin with 'routstrd npubs register'."
              : "This endpoint requires NIP-98 auth from a configured admin npub/pubkey.",
          }, 403);
        }

        return this.forward(req, body);
      } catch (err) {
        return this.json({
          error: err instanceof Error ? err.message : "Invalid NIP-98 token.",
        }, 401);
      }
    }

    return this.json({
      error:
        "Invalid Authorization format. Expected 'Bearer sk-...' or 'Nostr <base64-event>'.",
    }, 401);
  }

  /** Start the Bun HTTP server. */
  serve() {
    const { port, host } = this.config;
    const adminCount = this.store.countAdminNpubs();
    console.log(`routstrd-auth proxy listening on http://${host}:${port}`);
    console.log(`  Upstream: ${this.config.upstream}`);
    console.log(`  DB path:  ${this.config.dbPath}`);
    console.log(`  Admin npubs/pubkeys: ${adminCount}`);
    if (adminCount === 0) {
      console.warn(
        "  Warning: no admin npub/pubkey configured. " +
          "The first admin can be added without auth using POST /npubs.",
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
    return this.store.hasAdminPubkey(pubkey);
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
