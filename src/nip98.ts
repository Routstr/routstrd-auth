import { verifyEvent, type Event } from "nostr-tools";

export const NIP98_KIND = 27235;
export const NIP98_MAX_AGE_SECONDS = 60;

/**
 * How long the replay cache must remember a token. A token validates while
 * `|now - created_at| <= NIP98_MAX_AGE_SECONDS`, so the earliest it can be
 * presented is created_at - MAX_AGE and the latest is created_at + MAX_AGE — a
 * total live window of 2 * MAX_AGE. The cache entry (keyed at first
 * presentation) must outlive that whole window, otherwise a token could be
 * replayed in the gap after its cache entry expires but before it itself does.
 */
export const NIP98_REPLAY_TTL_SECONDS = 2 * NIP98_MAX_AGE_SECONDS;

export interface NIP98ValidationResult {
  pubkey: string;
  event: Event;
}

/**
 * Options controlling how a NIP-98 request is validated.
 */
export interface NIP98ValidateOptions {
  /**
   * Whether to honor `x-forwarded-proto` / `x-forwarded-host` when
   * reconstructing the public request URL the signed `u` tag is compared
   * against.
   *
   * SECURITY: these headers are client-controlled unless a trusted reverse
   * proxy strips/overwrites them. This MUST default to `false` so a directly
   * exposed server never trusts attacker-supplied forwarded headers. Only set
   * to `true` when this process is known to sit behind a trusted proxy that
   * rewrites these headers (see config `trustForwardedHeaders`).
   */
  trustForwardedHeaders?: boolean;

  /**
   * Optional replay cache. When supplied, the token signature (which uniquely
   * identifies a presented token and acts as its jti/nonce) is recorded after
   * successful validation, and any subsequent presentation of the SAME signed
   * token is rejected for the lifetime of the validation window.
   */
  replayCache?: ReplayCache;
}

/**
 * In-memory replay cache keyed by NIP-98 token signature (jti/nonce). Entries
 * expire after `ttlSeconds` (default NIP98_REPLAY_TTL_SECONDS = the full
 * 2*MAX_AGE validity window) so the cache always remembers a token for at least
 * as long as that token could otherwise still validate.
 *
 * This is intentionally per-process (single-process deployment). A multi-replica
 * deployment would need a shared store; that is out of scope here.
 */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlSeconds: number = NIP98_REPLAY_TTL_SECONDS) {
    this.ttlMs = ttlSeconds * 1000;
  }

  /** Drop expired entries. Called opportunistically on each access. */
  private sweep(now: number): void {
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id);
    }
  }

  /** Returns true if this id was already recorded (i.e. a replay). */
  has(id: string, now: number = Date.now()): boolean {
    const expiresAt = this.seen.get(id);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.seen.delete(id);
      return false;
    }
    return true;
  }

  /** Record an id as seen until now + ttl. */
  add(id: string, now: number = Date.now()): void {
    this.sweep(now);
    this.seen.set(id, now + this.ttlMs);
  }

  /** Current number of live (un-expired) entries — exposed for tests. */
  size(now: number = Date.now()): number {
    this.sweep(now);
    return this.seen.size;
  }
}

function base64UrlToBase64(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4;
  return padding === 0 ? base64 : base64 + "=".repeat(4 - padding);
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;

  let diff = 0;
  for (let i = 0; i < aBytes.byteLength; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getTag(event: Event, name: string): string | null {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",", 1)[0]?.trim() || null;
}

function getAbsoluteRequestUrl(req: Request, trustForwardedHeaders: boolean): string {
  // Bun's Request.url is already absolute.
  //
  // SECURITY / HARDENING:
  // x-forwarded-* headers are CLIENT-CONTROLLED unless a trusted reverse proxy
  // strips/overwrites them. If a request reaches this process without traversing
  // that trusted proxy, an attacker can set x-forwarded-host / x-forwarded-proto
  // to any value and make a NIP-98 token signed for an arbitrary public host
  // validate here (cross-host token replay). We therefore IGNORE forwarded
  // headers by default and only honor them when the operator has explicitly
  // declared this process to sit behind a trusted proxy (config
  // `trustForwardedHeaders`, env ROUTSTRD_AUTH_TRUSTED_PROXY). The real `host`
  // header is always honored so a normal reverse proxy that rewrites Host keeps
  // working.
  const url = new URL(req.url);
  const host = firstHeaderValue(req.headers.get("host"));
  if (host) url.host = host;

  if (trustForwardedHeaders) {
    const forwardedProto = firstHeaderValue(req.headers.get("x-forwarded-proto"));
    const forwardedHost = firstHeaderValue(req.headers.get("x-forwarded-host"));
    if (forwardedProto) {
      url.protocol = forwardedProto.endsWith(":")
        ? forwardedProto
        : `${forwardedProto}:`;
    }
    if (forwardedHost) url.host = forwardedHost;
  }

  return url.toString();
}

function decodeAuthorizationEvent(authorization: string): Event {
  const match = authorization.match(/^Nostr\s+(.+)$/i);
  if (!match) {
    throw new Error("Invalid Authorization format. Expected 'Nostr <base64-event>'.");
  }

  const token = base64UrlToBase64(match[1]!.trim());
  let json: string;
  try {
    json = atob(token);
  } catch {
    throw new Error("Invalid NIP-98 token encoding.");
  }

  let event: unknown;
  try {
    event = JSON.parse(json);
  } catch {
    throw new Error("Invalid NIP-98 event JSON.");
  }

  if (!event || typeof event !== "object") {
    throw new Error("Invalid NIP-98 event.");
  }

  return event as Event;
}

/**
 * Validate an `Authorization: Nostr ...` request according to NIP-98.
 *
 * The signed event must bind to the exact public request URL and method. If the
 * request has a non-empty body, a `payload` tag containing the SHA-256 hex hash
 * of the raw request body is required and must match.
 */
export async function validateNIP98Request(
  authorization: string,
  req: Request,
  body?: Uint8Array,
  options: NIP98ValidateOptions = {},
): Promise<NIP98ValidationResult> {
  const event = decodeAuthorizationEvent(authorization);

  if (event.kind !== NIP98_KIND) {
    throw new Error("Invalid NIP-98 event kind.");
  }

  if (!Number.isFinite(event.created_at)) {
    throw new Error("Invalid NIP-98 timestamp.");
  }

  const now = Math.round(Date.now() / 1000);
  const age = now - event.created_at;
  if (age > NIP98_MAX_AGE_SECONDS || age < -NIP98_MAX_AGE_SECONDS) {
    throw new Error("NIP-98 event timestamp is outside the allowed window.");
  }

  const urlTag = getTag(event, "u");
  if (urlTag !== getAbsoluteRequestUrl(req, options.trustForwardedHeaders === true)) {
    throw new Error("NIP-98 URL tag does not match this request.");
  }

  const methodTag = getTag(event, "method");
  if (!methodTag || methodTag.toLowerCase() !== req.method.toLowerCase()) {
    throw new Error("NIP-98 method tag does not match this request.");
  }

  if (body && body.byteLength > 0) {
    const payloadTag = getTag(event, "payload");
    if (!payloadTag) {
      throw new Error("NIP-98 payload tag is required for requests with a body.");
    }

    const bodyHash = await sha256Hex(body);
    if (!timingSafeEqual(payloadTag.toLowerCase(), bodyHash)) {
      throw new Error("NIP-98 payload tag does not match the request body hash.");
    }
  }

  if (!verifyEvent(event)) {
    throw new Error("Invalid NIP-98 event signature.");
  }

  // Replay protection: key the cache on the event SIGNATURE, not the event id.
  //
  // NIP-98 does not mandate a nonce tag, so two LEGITIMATE distinct requests
  // with the same method+url in the same second hash to the same event id
  // (id = sha256 over [0,pubkey,created_at,kind,tags,content]); keying on id
  // would false-positive and reject a user's second rapid identical request.
  // The Schnorr signature, however, includes per-signing auxiliary randomness,
  // so a freshly re-signed token has a different sig while a CAPTURED-and-
  // REPLAYED wire token is byte-identical (same sig). The sig therefore
  // uniquely identifies a specific presented token and is the correct jti.
  //
  // Only consult/record the cache AFTER the signature is verified so
  // unauthenticated junk cannot poison it.
  if (options.replayCache) {
    if (options.replayCache.has(event.sig)) {
      throw new Error("NIP-98 token has already been used (replay detected).");
    }
    options.replayCache.add(event.sig);
  }

  return { pubkey: event.pubkey, event };
}

export function isNIP98Authorization(authorization: string | null): boolean {
  return Boolean(authorization?.match(/^Nostr\s+.+$/i));
}
