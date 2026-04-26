#!/usr/bin/env bun
import { program } from "commander";
import { finalizeEvent, nip19, type EventTemplate } from "nostr-tools";
import { NIP98_KIND } from "./nip98";

interface AddClientResponse {
  output?: {
    message?: string;
    client?: {
      id: string;
      name: string;
      apiKey: string;
      createdAt: number;
    };
  };
  error?: string;
}

interface ClientsResponse {
  output?: {
    clients: Array<{
      id: string;
      name: string;
      apiKey: string;
      createdAt: number;
      lastUsed?: number | null;
    }>;
    totalCount: number;
  };
  error?: string;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Expected a 64-char hex private key or an nsec private key.");
  }

  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function parseSecretKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Missing Nostr private key.");
  }

  if (trimmed.toLowerCase().startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("Invalid nsec private key.");
    }
    return decoded.data;
  }

  return hexToBytes(trimmed);
}

function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  // Keep path support, but remove a trailing slash so `/clients/add` appends
  // predictably whether the user passes `http://host` or `http://host/`.
  return url.toString().replace(/\/$/, "");
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64EncodeUtf8(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

async function createNIP98Authorization(
  secretKey: Uint8Array,
  url: string,
  method: string,
  body?: Uint8Array,
): Promise<string> {
  const tags = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];

  if (body && body.byteLength > 0) {
    tags.push(["payload", await sha256Hex(body)]);
  }

  const template: EventTemplate = {
    kind: NIP98_KIND,
    created_at: Math.round(Date.now() / 1000),
    content: "",
    tags,
  };

  const signed = finalizeEvent(template, secretKey);
  return `Nostr ${base64EncodeUtf8(JSON.stringify(signed))}`;
}

async function requestJson<T>(
  secretKey: Uint8Array,
  url: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<T> {
  const bodyBytes = init.body ? new TextEncoder().encode(init.body) : undefined;
  const authorization = await createNIP98Authorization(
    secretKey,
    url,
    init.method,
    bodyBytes,
  );

  const res = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: authorization,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : text;
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${message}`);
  }

  return json as T;
}

function printClients(clients: ClientsResponse["output"]): void {
  if (!clients || clients.clients.length === 0) {
    console.log("No clients found.");
    return;
  }

  console.log(`\nClients (${clients.totalCount}):`);
  for (const client of clients.clients) {
    console.log(`- ${client.name} (${client.id})`);
    console.log(`  apiKey: ${client.apiKey}`);
    console.log(`  createdAt: ${new Date(client.createdAt).toISOString()}`);
    if (client.lastUsed) {
      console.log(`  lastUsed: ${new Date(client.lastUsed).toISOString()}`);
    }
  }
}

program
  .name("nip98-client")
  .description("Small NIP-98 client for adding and listing routstrd clients")
  .requiredOption("-k, --key <nsec-or-hex>", "Admin Nostr private key (nsec or 64-char hex). Can also use NOSTR_NSEC or NOSTR_SECRET_KEY env var.", process.env.NOSTR_NSEC || process.env.NOSTR_SECRET_KEY)
  .option("-u, --url <base-url>", "routstrd-auth base URL", process.env.ROUTSTRD_AUTH_URL || "http://localhost:8008")
  .option("-n, --name <client-name>", "Client name to add. If omitted, only lists existing clients.")
  .option("--json", "Print the final /clients response as JSON")
  .action(async (opts: { key: string; url: string; name?: string; json?: boolean }) => {
    const secretKey = parseSecretKey(opts.key);

    if (opts.name) {
      const addUrl = endpointUrl(opts.url, "/clients/add");
      const body = JSON.stringify({ name: opts.name });
      const added = await requestJson<AddClientResponse>(secretKey, addUrl, {
        method: "POST",
        body,
      });

      if (added.output?.message) {
        console.log(added.output.message);
      }
      if (added.output?.client) {
        console.log(`Added API key: ${added.output.client.apiKey}`);
      }
    }

    const clientsUrl = endpointUrl(opts.url, "/clients");
    const clients = await requestJson<ClientsResponse>(secretKey, clientsUrl, {
      method: "GET",
    });

    if (opts.json) {
      console.log(JSON.stringify(clients, null, 2));
    } else {
      printClients(clients.output);
    }
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
