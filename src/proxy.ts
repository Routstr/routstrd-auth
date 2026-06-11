import { normalizeNostrPubkey, type AuthProxyConfig } from "./config";
import { validateNIP98Request } from "./nip98";
import { type Client, type NpubRole, AuthStore } from "./store";

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
    headers.delete("content-length");

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

  private parseNpubBody(
    raw: unknown,
  ): { pubkey: string; role?: NpubRole } | Response {
    if (raw === undefined || raw === null || (ArrayBuffer.isView(raw) && (raw as ArrayBufferView).byteLength === 0)) {
      return this.json({ error: "Request body is required. Provide { \"npub\": \"npub1...\" } or { \"pubkey\": \"<64-char hex>\" }." }, 400);
    }

    // Accept raw Uint8Array
    if (ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      if (bytes.byteLength === 0) {
        return this.json({ error: "Request body is required. Provide { \"npub\": \"npub1...\" } or { \"pubkey\": \"<64-char hex>\" }." }, 400);
      }
      const buf = bytes as Uint8Array;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(buf));
      } catch {
        return this.json({ error: "Invalid JSON body." }, 400);
      }
      return this.extractNpub(parsed);
    }

    // Accept already-parsed JSON object
    return this.extractNpub(raw);
  }

  private extractNpub(parsed: unknown): { pubkey: string; role?: NpubRole } | Response {
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

    const roleRaw = parsed && typeof parsed === "object"
      ? (parsed as { role?: unknown }).role
      : undefined;
    if (roleRaw === undefined) {
      return { pubkey };
    }

    if (roleRaw === "admin" || roleRaw === "user") {
      return { pubkey, role: roleRaw };
    }

    return this.json({ error: "Invalid role. Expected 'admin' or 'user'." }, 400);
  }

  private async authenticateNpub(
    req: Request,
    authorization: string | null,
    body: Uint8Array | undefined,
    requiredRole: NpubRole,
  ): Promise<{ pubkey: string; npub: string; role: NpubRole } | Response> {
    if (!authorization) {
      return this.json({
        error:
          "Missing Authorization header. This endpoint requires NIP-98 auth from a registered npub/pubkey.",
      }, 401);
    }

    if (authorization.match(/^Bearer\s+(.+)$/i)) {
      return this.json({
        error: requiredRole === "admin"
          ? "Admin-only action. This endpoint requires NIP-98 auth from a registered npub/pubkey."
          : "This endpoint requires NIP-98 auth from a registered npub/pubkey.",
      }, 403);
    }

    if (!authorization.match(/^Nostr\s+(.+)$/i)) {
      return this.json({
        error: "Invalid Authorization format. Expected 'Nostr <base64-event>'.",
      }, 401);
    }

    try {
      const { pubkey } = await validateNIP98Request(authorization, req, body);

      const entry = this.store.getNpubByPubkey(pubkey);
      if (!entry) {
        return this.json({
          error: this.store.countNpubs() === 0
            ? "This endpoint requires a registered npub/pubkey, but none is configured. Register the first admin with 'routstrd npubs register'."
            : "This endpoint requires NIP-98 auth from a registered npub/pubkey.",
        }, 403);
      }

      if (requiredRole === "admin" && entry.role !== "admin") {
        return this.json({
          error: "Admin access required. Only admin npubs can perform this action.",
        }, 403);
      }

      return { pubkey, npub: entry.npub, role: entry.role };
    } catch (err) {
      return this.json({
        error: err instanceof Error ? err.message : "Invalid NIP-98 token.",
      }, 401);
    }
  }

  private getNpubSuffix(npub: string): string {
    return npub.slice(-7);
  }

  private addSuffixToId(id: string, suffix: string): string {
    return id.endsWith(`-${suffix}`) ? id : `${id}-${suffix}`;
  }

  private removeSuffixFromId(id: string, suffix: string): string {
    const suffixStr = `-${suffix}`;
    return id.endsWith(suffixStr) ? id.slice(0, -suffixStr.length) : id;
  }

  private sanitizeClientId(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }

  private clientBelongsToNpub(client: Client, npub: string, suffix: string): boolean {
    // Prefer the explicit owner when present. The suffix fallback keeps older
    // clients usable until they are re-created/migrated with ownerNpub.
    return client.ownerNpub ? client.ownerNpub === npub : client.clientId.endsWith(`-${suffix}`);
  }

  private stripClientOwnerSuffix(client: Client, suffix: string, ownerNpub: string) {
    return {
      id: this.removeSuffixFromId(client.clientId, suffix),
      name: client.name,
      apiKey: client.apiKey,
      createdAt: client.createdAt,
      lastUsed: client.lastUsed,
      ownerNpub: client.ownerNpub ?? ownerNpub,
    };
  }

  private async handleClients(req: Request, path: string): Promise<Response> {
    const body = req.method === "GET" || req.method === "HEAD"
      ? undefined
      : new Uint8Array(await req.arrayBuffer());
    const auth = await this.authenticateNpub(
      req,
      req.headers.get("authorization"),
      body,
      "user",
    );
    if (auth instanceof Response) return auth;

    const suffix = this.getNpubSuffix(auth.npub);

    if (req.method === "GET" && path === "/clients") {
      const clients = this.store.getClients()
        .filter((c) => this.clientBelongsToNpub(c, auth.npub, suffix))
        .map((c) => this.stripClientOwnerSuffix(c, suffix, auth.npub));

      return this.json({
        output: {
          clients,
          totalCount: clients.length,
        },
      });
    }

    if (req.method === "POST" && path === "/clients/add") {
      let parsed: Record<string, unknown>;
      try {
        parsed = body && body.byteLength > 0
          ? JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
          : {};
      } catch {
        return this.json({ error: "Invalid JSON body." }, 400);
      }

      const name = parsed.name;
      const explicitId = parsed.id;
      if (!name || typeof name !== "string" || name.trim() === "") {
        return this.json({ error: "Missing required 'name' field (must be a non-empty string)." }, 400);
      }
      if (!explicitId || typeof explicitId !== "string" || explicitId.trim() === "") {
        return this.json({ error: "Missing required 'id' field (must be a non-empty string)." }, 400);
      }

      const unsuffixedId = this.removeSuffixFromId(this.sanitizeClientId(explicitId), suffix);
      if (!unsuffixedId) {
        return this.json({ error: "Invalid client id. Must contain alphanumeric characters." }, 400);
      }

      const upstreamBody = new TextEncoder().encode(JSON.stringify({
        ...parsed,
        id: this.addSuffixToId(unsuffixedId, suffix),
        ownerNpub: auth.npub,
      }));

      const upstreamReq = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: upstreamBody,
      });
      const response = await this.forward(upstreamReq, upstreamBody);

      if (!response.ok) return response;
      const payload = await response.json() as {
        output?: { client?: { id?: string; ownerNpub?: string } };
        error?: string;
      };
      if (payload.output?.client?.id) {
        payload.output.client.id = this.removeSuffixFromId(payload.output.client.id, suffix);
      }
      if (payload.output?.client && !payload.output.client.ownerNpub) {
        payload.output.client.ownerNpub = auth.npub;
      }
      return this.json(payload, response.status);
    }

    if (req.method === "POST" && path === "/clients/delete") {
      let parsed: Record<string, unknown>;
      try {
        parsed = body && body.byteLength > 0
          ? JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
          : {};
      } catch {
        return this.json({ error: "Invalid JSON body." }, 400);
      }

      const id = parsed.id;
      if (!id || typeof id !== "string" || id.trim() === "") {
        return this.json({ error: "Missing required 'id' field (must be a non-empty string)." }, 400);
      }

      const unsuffixedId = this.removeSuffixFromId(this.sanitizeClientId(id), suffix);
      if (!unsuffixedId) {
        return this.json({ error: "Invalid client id. Must contain alphanumeric characters." }, 400);
      }

      const resolvedId = this.addSuffixToId(unsuffixedId, suffix);
      const client = this.store.getClients().find((c) => c.clientId === resolvedId);
      if (!client || !this.clientBelongsToNpub(client, auth.npub, suffix)) {
        return this.json({ error: `Client with id '${unsuffixedId}' not found.` }, 404);
      }

      const upstreamBody = new TextEncoder().encode(JSON.stringify({
        ...parsed,
        id: resolvedId,
      }));
      const upstreamReq = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: upstreamBody,
      });
      const response = await this.forward(upstreamReq, upstreamBody);

      if (!response.ok) return response;
      const payload = await response.json() as {
        output?: { message?: string; id?: string };
        error?: string;
      };
      if (payload.output?.id) {
        payload.output.id = this.removeSuffixFromId(payload.output.id, suffix);
      }
      return this.json(payload, response.status);
    }

    return this.json({ error: "Not found." }, 404);
  }

  private async handleUsage(req: Request): Promise<Response> {
    if (req.method !== "GET") {
      return this.json({ error: "Not found." }, 404);
    }

    const auth = await this.authenticateNpub(
      req,
      req.headers.get("authorization"),
      undefined,
      "user",
    );
    if (auth instanceof Response) return auth;

    // Forward to daemon with npub filter; daemon handles scoping and suffix stripping.
    const url = new URL(req.url);
    url.searchParams.set("npub", auth.npub);

    const modifiedReq = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
    });

    return this.forward(modifiedReq);
  }

  /** Handle /npubs management endpoints. */
  private async handleNpubs(req: Request, path: string): Promise<Response> {
    if (req.method === "GET" && path === "/npubs") {
      const npubs = this.store.listNpubs();
      return this.json({
        npubs: npubs.map((n) => ({ npub: n.npub, role: n.role })),
      });
    }

    if (req.method === "POST" && path === "/npubs") {
      const body = new Uint8Array(await req.arrayBuffer());
      const anyNpubs = this.store.countNpubs() > 0;
      let createdBy: string | null = null;

      if (anyNpubs) {
        const auth = await this.authenticateNpub(
          req,
          req.headers.get("authorization"),
          body,
          "admin",
        );
        if (auth instanceof Response) return auth;
        createdBy = auth.pubkey;
      }

      const parsed = this.parseNpubBody(body);
      if (parsed instanceof Response) return parsed;

      // Bootstrap the very first registered npub as admin by default. After
      // bootstrap, default to user unless an admin explicitly sets role=admin.
      const role = parsed.role ?? (anyNpubs ? "user" : "admin");
      const entry = this.store.addNpub(parsed.pubkey, role, createdBy);
      return this.json({
        npub: entry.npub,
        pubkey: entry.pubkey,
        role: entry.role,
        added: entry.added,
      }, entry.added ? 201 : 200);
    }

    if (req.method === "DELETE" && (path === "/npubs" || path.startsWith("/npubs/"))) {
      const body = req.method === "GET" || req.method === "HEAD"
        ? undefined
        : new Uint8Array(await req.arrayBuffer());
      const auth = await this.authenticateNpub(
        req,
        req.headers.get("authorization"),
        body,
        "admin",
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
        const parsed = this.parseNpubBody(body);
        if (parsed instanceof Response) return parsed;
        pubkey = parsed.pubkey;
      }

      if (!pubkey) {
        return this.json({ error: "Provide the npub/pubkey to remove in /npubs/<npub>, ?npub=..., or the JSON body." }, 400);
      }

      const removed = this.store.removeNpub(pubkey);
      return this.json({ removed });
    }

    if (req.method === "PATCH" && path === "/npubs") {
      const body = new Uint8Array(await req.arrayBuffer());
      const auth = await this.authenticateNpub(
        req,
        req.headers.get("authorization"),
        body,
        "admin",
      );
      if (auth instanceof Response) return auth;

      const parsed = this.parseNpubBody(body);
      if (parsed instanceof Response) return parsed;

      if (!parsed.role) {
        return this.json({ error: "Missing required 'role' field. Expected 'admin' or 'user'." }, 400);
      }

      const updated = this.store.updateNpubRole(parsed.pubkey, parsed.role);
      if (!updated) {
        return this.json({ error: "npub/pubkey not found." }, 404);
      }

      return this.json({
        npub: updated.npub,
        pubkey: updated.pubkey,
        role: updated.role,
      });
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

    if (path === "/clients" || path === "/clients/add" || path === "/clients/delete") {
      return this.handleClients(req, path);
    }

    if (path === "/usage" || path === "/usage/summary") {
      return this.handleUsage(req);
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
      // API key: block /clients/add and wallet endpoints
      if (AuthProxy.isRestrictedPath(path)) {
        return this.json({
          error: "API keys cannot access this endpoint. Use NIP-98 auth from a registered npub/pubkey.",
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

      // Determine required role first to generate the right error message
      if (AuthProxy.isAdminPath(path)) {
        const auth = await this.authenticateNpub(req, authorization, body, "admin");
        if (auth instanceof Response) return auth;
        return this.forward(req, body);
      }

      if (AuthProxy.isNpubRestrictedPath(path)) {
        const auth = await this.authenticateNpub(req, authorization, body, "user");
        if (auth instanceof Response) return auth;
        return this.forward(req, body);
      }

      // Default: any registered npub can access
      const { pubkey } = await validateNIP98Request(authorization, req, body);
      if (!this.store.hasNpub(pubkey)) {
        return this.json({
          error: this.store.countNpubs() === 0
            ? "This endpoint requires a registered npub/pubkey, but none is configured. Register the first admin with 'routstrd npubs register'."
            : "This endpoint requires NIP-98 auth from a registered npub/pubkey.",
        }, 403);
      }

      return this.forward(req, body);
    }

    return this.json({
      error:
        "Invalid Authorization format. Expected 'Bearer sk-...' or 'Nostr <base64-event>'.",
    }, 401);
  }

  /** Start the Bun HTTP server. */
  serve() {
    const { port, host } = this.config;
    const npubCount = this.store.countNpubs();
    console.log(`routstrd-auth proxy listening on http://${host}:${port}`);
    console.log(`  Upstream: ${this.config.upstream}`);
    console.log(`  DB path:  ${this.config.dbPath}`);
    console.log(`  Registered npubs: ${npubCount}`);
    if (npubCount === 0) {
      console.warn(
        "  Warning: no registered npub/pubkey. " +
          "The first admin can be registered without auth using POST /npubs.",
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

  /** Minimal public endpoints that don't require auth. */
  static PUBLIC_PATHS = new Set([
    "/health",
    "/ping",
    "/models",
    "/v1/models",
  ]);

  /** Public path prefixes. */
  static PUBLIC_PREFIXES = ["/models/", "/v1/models/"];

  /** Endpoints that require an admin NIP-98 identity. */
  static ADMIN_PATHS = new Set([
    "/wallet/send/cashu",
    "/wallet/send/bolt11",
  ]);

  /** Endpoints restricted to registered npubs (admin + user). API keys cannot access. */
  static NPUB_RESTRICTED_PATHS = new Set([
    "/wallet/status",
    "/wallet/unlock",
    "/wallet/balance",
    "/wallet/receive/cashu",
    "/wallet/receive/bolt11",
    "/wallet/mints",
    "/wallet/mints/info",
  ]);

  static isPublicPath(path: string): boolean {
    if (AuthProxy.PUBLIC_PATHS.has(path)) return true;
    return AuthProxy.PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
  }

  static isAdminPath(path: string): boolean {
    return AuthProxy.ADMIN_PATHS.has(path);
  }

  static isNpubRestrictedPath(path: string): boolean {
    return AuthProxy.NPUB_RESTRICTED_PATHS.has(path);
  }

  static isRestrictedPath(path: string): boolean {
    return this.isAdminPath(path) || this.isNpubRestrictedPath(path);
  }
}
