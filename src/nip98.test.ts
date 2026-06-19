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
  NIP98_KIND,
  NIP98_MAX_AGE_SECONDS,
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

    // SECURITY / HARDENING NOTE:
    // getAbsoluteRequestUrl() blindly trusts x-forwarded-host / x-forwarded-proto
    // when rebuilding the URL the signed `u` tag is compared against. Any client
    // that can set these headers (e.g. the request did NOT actually traverse the
    // intended trusted reverse proxy) can make a NIP-98 token signed for an
    // arbitrary host validate against this server — enabling cross-host token
    // replay. This test documents the CURRENT (vulnerable) behavior so that any
    // future hardening (an allowlist / trusted-proxy flag) will flip it to a
    // rejection and surface the change loudly.
    it("CURRENTLY accepts a forged x-forwarded-host that matches the signed host (documents trust gap)", async () => {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      // Token signed for the attacker-chosen public host.
      const event = signEvent(sk, {
        url: "https://evil.test/wallet/balance",
        method: "GET",
      });
      // Request actually arrives at localhost but carries forged forwarded
      // headers that make the server reconstruct https://evil.test/...
      const req = makeRequest("http://localhost/wallet/balance", "GET", {
        "x-forwarded-host": "evil.test",
        "x-forwarded-proto": "https",
      });
      const result = await validateNIP98Request(toAuthHeader(event), req);
      // Documenting the current trust gap. If hardening lands, change this to
      // `.rejects.toThrow(...)`.
      expect(result.pubkey).toBe(pk);
    });
  });

  // ─── replay within the validity window ─────────────────────────────────────

  // SECURITY / HARDENING NOTE:
  // There is no nonce / jti / seen-event store, so the SAME signed event can be
  // replayed any number of times within the ±60s window. This test documents
  // that the second presentation of an identical token is CURRENTLY still
  // accepted. A future replay cache should flip the second call to a rejection.
  it("CURRENTLY accepts the same event replayed within the window (no nonce store)", async () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const event = signEvent(sk, { url, method: "GET" });
    const header = toAuthHeader(event);

    const first = await validateNIP98Request(header, makeRequest(url, "GET"));
    const second = await validateNIP98Request(header, makeRequest(url, "GET"));
    expect(first.pubkey).toBe(pk);
    expect(second.pubkey).toBe(pk);
  });
});
