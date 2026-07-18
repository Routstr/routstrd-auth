import { describe, it, expect } from "bun:test";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  type Event,
} from "nostr-tools";
import {
  validateNIP98Request,
  isNIP98Authorization,
  ReplayCache,
  NIP98_KIND,
  NIP98_MAX_AGE_SECONDS,
  NIP98_REPLAY_TTL_SECONDS,
} from "./nip98";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface SignOpts {
  url: string;
  method: string;
  createdAt?: number;
  payloadHash?: string;
  kind?: number;
}

function signEvent(sk: Uint8Array, opts: SignOpts): Event {
  const tags: string[][] = [
    ["u", opts.url],
    ["method", opts.method],
  ];
  if (opts.payloadHash) tags.push(["payload", opts.payloadHash]);

  return finalizeEvent(
    {
      kind: opts.kind ?? NIP98_KIND,
      created_at: opts.createdAt ?? Math.round(Date.now() / 1000),
      tags,
      content: "",
    },
    sk,
  );
}

/** Encode a signed event into an `Authorization: Nostr ...` header value. */
function toAuthHeader(event: Event): string {
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

function makeRequest(
  url: string,
  method: string,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(url, { method, headers: extraHeaders });
}

// ─── isNIP98Authorization ────────────────────────────────────────────────────

describe("isNIP98Authorization", () => {
  it("recognizes a Nostr authorization header", () => {
    expect(isNIP98Authorization("Nostr abc123")).toBe(true);
    expect(isNIP98Authorization("nostr abc123")).toBe(true);
  });

  it("rejects Bearer / empty / null", () => {
    expect(isNIP98Authorization("Bearer sk-xyz")).toBe(false);
    expect(isNIP98Authorization("Nostr ")).toBe(false);
    expect(isNIP98Authorization(null)).toBe(false);
  });
});

// ─── validateNIP98Request ────────────────────────────────────────────────────

describe("validateNIP98Request", () => {
  const url = "http://localhost/wallet/balance";

  it("accepts a valid GET event and returns the signer pubkey", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const event = signEvent(sk, { url, method: "GET" });
    const result = await validateNIP98Request(
      toAuthHeader(event),
      makeRequest(url, "GET"),
    );
    expect(result.pubkey).toBe(pk);
  });

  it("rejects an expired event (created_at now-61s)", async () => {
    const sk = generateSecretKey();
    const now = Math.round(Date.now() / 1000);
    const event = signEvent(sk, {
      url,
      method: "GET",
      createdAt: now - (NIP98_MAX_AGE_SECONDS + 1),
    });
    await expect(
      validateNIP98Request(toAuthHeader(event), makeRequest(url, "GET")),
    ).rejects.toThrow("outside the allowed window");
  });

  it("rejects a future-skewed event (created_at now+61s)", async () => {
    const sk = generateSecretKey();
    const now = Math.round(Date.now() / 1000);
    const event = signEvent(sk, {
      url,
      method: "GET",
      createdAt: now + (NIP98_MAX_AGE_SECONDS + 1),
    });
    await expect(
      validateNIP98Request(toAuthHeader(event), makeRequest(url, "GET")),
    ).rejects.toThrow("outside the allowed window");
  });

  it("rejects a tampered signature", async () => {
    const sk = generateSecretKey();
    const event = signEvent(sk, { url, method: "GET" });
    // Flip the last hex char of the signature.
    const lastChar = event.sig.slice(-1);
    const tamperedChar = lastChar === "a" ? "b" : "a";
    const tampered: Event = { ...event, sig: event.sig.slice(0, -1) + tamperedChar };
    await expect(
      validateNIP98Request(toAuthHeader(tampered), makeRequest(url, "GET")),
    ).rejects.toThrow("Invalid NIP-98 event signature");
  });

  it("rejects the wrong event kind", async () => {
    const sk = generateSecretKey();
    const event = signEvent(sk, { url, method: "GET", kind: 1 });
    await expect(
      validateNIP98Request(toAuthHeader(event), makeRequest(url, "GET")),
    ).rejects.toThrow("Invalid NIP-98 event kind");
  });

  it("rejects a URL-tag mismatch", async () => {
    const sk = generateSecretKey();
    const event = signEvent(sk, { url: "http://localhost/other", method: "GET" });
    await expect(
      validateNIP98Request(toAuthHeader(event), makeRequest(url, "GET")),
    ).rejects.toThrow("URL tag does not match");
  });

  it("rejects a method mismatch", async () => {
    const sk = generateSecretKey();
    const event = signEvent(sk, { url, method: "POST" });
    await expect(
      validateNIP98Request(toAuthHeader(event), makeRequest(url, "GET")),
    ).rejects.toThrow("method tag does not match");
  });

  it("requires a payload tag when the request has a body", async () => {
    const postUrl = "http://localhost/wallet/receive/cashu";
    const sk = generateSecretKey();
    const body = new TextEncoder().encode(JSON.stringify({ token: "cashuA..." }));
    // Sign without a payload tag.
    const event = signEvent(sk, { url: postUrl, method: "POST" });
    await expect(
      validateNIP98Request(
        toAuthHeader(event),
        makeRequest(postUrl, "POST"),
        body,
      ),
    ).rejects.toThrow("payload tag is required");
  });

  it("rejects a payload tag that does not match the body hash", async () => {
    const postUrl = "http://localhost/wallet/receive/cashu";
    const sk = generateSecretKey();
    const body = new TextEncoder().encode(JSON.stringify({ token: "real" }));
    const wrongHash = await sha256Hex(new TextEncoder().encode("different body"));
    const event = signEvent(sk, {
      url: postUrl,
      method: "POST",
      payloadHash: wrongHash,
    });
    await expect(
      validateNIP98Request(
        toAuthHeader(event),
        makeRequest(postUrl, "POST"),
        body,
      ),
    ).rejects.toThrow("does not match the request body hash");
  });

  it("accepts a correct payload hash", async () => {
    const postUrl = "http://localhost/wallet/receive/cashu";
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const body = new TextEncoder().encode(JSON.stringify({ token: "real" }));
    const hash = await sha256Hex(body);
    const event = signEvent(sk, {
      url: postUrl,
      method: "POST",
      payloadHash: hash,
    });
    const result = await validateNIP98Request(
      toAuthHeader(event),
      makeRequest(postUrl, "POST"),
      body,
    );
    expect(result.pubkey).toBe(pk);
  });

  it("rejects a malformed authorization header", async () => {
    await expect(
      validateNIP98Request("Bearer sk-xyz", makeRequest(url, "GET")),
    ).rejects.toThrow("Invalid Authorization format");
  });

  // ─── x-forwarded trust hardening ───────────────────────────────────────────

  describe("x-forwarded-host URL reconstruction", () => {
    it("rejects a cross-host token when no forwarded headers are present", async () => {
      // Event signed for a DIFFERENT public host than the one actually serving
      // the request. Without forwarded headers, the reconstructed URL is the
      // real localhost URL, so the cross-host token must be rejected.
      const sk = generateSecretKey();
      const event = signEvent(sk, {
        url: "https://evil.test/wallet/balance",
        method: "GET",
      });
      await expect(
        validateNIP98Request(
          toAuthHeader(event),
          makeRequest("http://localhost/wallet/balance", "GET"),
        ),
      ).rejects.toThrow("URL tag does not match");
    });

    // SECURITY / HARDENING (FIXED):
    // getAbsoluteRequestUrl() no longer trusts x-forwarded-host /
    // x-forwarded-proto by default. A forged forwarded header from a client that
    // did NOT traverse a trusted reverse proxy can no longer make a NIP-98 token
    // signed for an arbitrary host validate. The default (no options /
    // trustForwardedHeaders unset) MUST reject the cross-host token.
    it("rejects a forged x-forwarded-host by default (forwarded headers untrusted)", async () => {
      const sk = generateSecretKey();
      // Token signed for the attacker-chosen public host.
      const event = signEvent(sk, {
        url: "https://evil.test/wallet/balance",
        method: "GET",
      });
      // Request actually arrives at localhost but carries forged forwarded
      // headers. Without trusted-proxy config the headers are ignored, so the
      // reconstructed URL stays http://localhost/... and the token is rejected.
      const req = makeRequest("http://localhost/wallet/balance", "GET", {
        "x-forwarded-host": "evil.test",
        "x-forwarded-proto": "https",
      });
      await expect(
        validateNIP98Request(toAuthHeader(event), req),
      ).rejects.toThrow("URL tag does not match");
    });

    it("rejects a forged x-forwarded-host even when other env trust is off (explicit false)", async () => {
      const sk = generateSecretKey();
      const event = signEvent(sk, {
        url: "https://evil.test/wallet/balance",
        method: "GET",
      });
      const req = makeRequest("http://localhost/wallet/balance", "GET", {
        "x-forwarded-host": "evil.test",
        "x-forwarded-proto": "https",
      });
      await expect(
        validateNIP98Request(toAuthHeader(event), req, undefined, {
          trustForwardedHeaders: false,
        }),
      ).rejects.toThrow("URL tag does not match");
    });

    it("honors x-forwarded-host ONLY when trustForwardedHeaders is enabled (trusted proxy)", async () => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      // Client signs for the public host the trusted proxy fronts.
      const event = signEvent(sk, {
        url: "https://api.example.com/wallet/balance",
        method: "GET",
      });
      const req = makeRequest("http://localhost/wallet/balance", "GET", {
        "x-forwarded-host": "api.example.com",
        "x-forwarded-proto": "https",
      });
      const result = await validateNIP98Request(
        toAuthHeader(event),
        req,
        undefined,
        { trustForwardedHeaders: true },
      );
      expect(result.pubkey).toBe(pk);
    });
  });

  // ─── replay within the validity window ─────────────────────────────────────

  // SECURITY / HARDENING (FIXED):
  // A replay cache (keyed on the NIP-98 event id, which doubles as the
  // nonce/jti) now rejects the SECOND presentation of an identical signed token
  // within the validation window.
  it("rejects the same event replayed within the window (nonce cache)", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const event = signEvent(sk, { url, method: "GET" });
    const header = toAuthHeader(event);
    const replayCache = new ReplayCache();

    const first = await validateNIP98Request(header, makeRequest(url, "GET"), undefined, {
      replayCache,
    });
    expect(first.pubkey).toBe(pk);
    await expect(
      validateNIP98Request(header, makeRequest(url, "GET"), undefined, { replayCache }),
    ).rejects.toThrow("replay");
  });

  it("still accepts a replay when no replay cache is supplied (opt-in at call site)", async () => {
    // The pure validator is replay-protected only when a cache is passed; the
    // proxy always passes one. This guards the backward-compatible default.
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const event = signEvent(sk, { url, method: "GET" });
    const header = toAuthHeader(event);

    const first = await validateNIP98Request(header, makeRequest(url, "GET"));
    const second = await validateNIP98Request(header, makeRequest(url, "GET"));
    expect(first.pubkey).toBe(pk);
    expect(second.pubkey).toBe(pk);
  });

  it("does NOT poison the replay cache on a failed (bad-signature) validation", async () => {
    const sk = generateSecretKey();
    const event = signEvent(sk, { url, method: "GET" });
    const lastChar = event.sig.slice(-1);
    const tamperedChar = lastChar === "a" ? "b" : "a";
    const tampered: Event = { ...event, sig: event.sig.slice(0, -1) + tamperedChar };
    const replayCache = new ReplayCache();

    // The tampered event fails signature verification and must NOT be recorded.
    await expect(
      validateNIP98Request(toAuthHeader(tampered), makeRequest(url, "GET"), undefined, {
        replayCache,
      }),
    ).rejects.toThrow("Invalid NIP-98 event signature");
    expect(replayCache.size()).toBe(0);

    // The genuine event must still be accepted exactly once.
    const ok = await validateNIP98Request(toAuthHeader(event), makeRequest(url, "GET"), undefined, {
      replayCache,
    });
    expect(ok.pubkey).toBe(getPublicKey(sk));
    expect(replayCache.size()).toBe(1);
  });
});

// ─── ReplayCache unit tests ──────────────────────────────────────────────────

describe("ReplayCache", () => {
  it("reports unseen ids as not present, then present after add", () => {
    const cache = new ReplayCache(60);
    expect(cache.has("id-1")).toBe(false);
    cache.add("id-1");
    expect(cache.has("id-1")).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it("expires entries after the TTL window (id usable again)", () => {
    const cache = new ReplayCache(60); // 60s TTL
    const t0 = 1_000_000;
    cache.add("id-1", t0);
    // Within window: replay detected.
    expect(cache.has("id-1", t0 + 59_000)).toBe(true);
    // Past window: entry expired, no longer a replay.
    expect(cache.has("id-1", t0 + 61_000)).toBe(false);
    expect(cache.size(t0 + 61_000)).toBe(0);
  });

  it("default TTL covers the FULL token validity window (no late-replay gap)", () => {
    // A token presented at the earliest moment it is valid (created_at - MAX_AGE)
    // must still be remembered at the latest moment it is valid
    // (created_at + MAX_AGE): a 2*MAX_AGE span. The default cache must not expire
    // the entry before then.
    expect(NIP98_REPLAY_TTL_SECONDS).toBe(2 * NIP98_MAX_AGE_SECONDS);
    const cache = new ReplayCache(); // default TTL
    const firstSeen = 1_000_000; // == created_at - MAX_AGE (earliest presentation)
    cache.add("sig", firstSeen);
    const latestValid = firstSeen + 2 * NIP98_MAX_AGE_SECONDS * 1000;
    // Replay one millisecond before the token's own validity expires.
    expect(cache.has("sig", latestValid - 1)).toBe(true);
  });

  it("sweeps expired entries on add so the map does not grow unbounded", () => {
    const cache = new ReplayCache(10); // 10s TTL
    const t0 = 1_000_000;
    cache.add("old", t0);
    expect(cache.size(t0)).toBe(1);
    // Add a fresh entry well past the old one's TTL; the sweep should evict "old".
    cache.add("new", t0 + 20_000);
    expect(cache.has("old", t0 + 20_000)).toBe(false);
    expect(cache.has("new", t0 + 20_000)).toBe(true);
    expect(cache.size(t0 + 20_000)).toBe(1);
  });
});
