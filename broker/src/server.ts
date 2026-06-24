/**
 * BnF broker — the single egress chokepoint for all BnF traffic.
 *
 * Generalises the demo `gallica-relay` into a real gateway: it owns the OAuth
 * token (single-flight), enforces the shared 300/min global + 12/min-per-IP
 * manifest + politeness buckets, and centralises 429/Retry-After backoff. The
 * BnF KEY/SECRET live ONLY here — the app and worker hold no BnF credentials,
 * they just POST a fetch request and get the upstream status + bytes verbatim.
 *
 * Contract (mirrors the relay so clients stay trivial):
 *   POST /fetch   {"url": "...", "accept": "..."}  -> upstream status + body verbatim
 *   GET  /health  -> {"ok": true}
 *
 * The upstream status is mirrored unchanged so the caller's classification is
 * identical whether or not the broker is in the path. On 429 the broker BOTH
 * freezes the offending bucket (so it stops sending) AND returns the 429 to the
 * caller (which also backs off) — belt and suspenders.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { fetch as undiciFetch } from "undici";

import {
  config,
  isAllowedUpstream,
  isManifest,
  isPartnerApi,
} from "./config.js";
import { retryAfterToEpochMs, TokenBucket } from "./rate.js";
import { getAuthHeader } from "./token.js";

const buckets = {
  global: new TokenBucket({ rpm: config.globalRpm, burst: config.globalBurst }),
  manifest: new TokenBucket({ rpm: config.manifestRpm, burst: config.manifestBurst }),
  external: new TokenBucket({ rpm: config.externalRpm, burst: config.externalBurst }),
};

interface Plan {
  /** Buckets to acquire before sending, in order. */
  acquire: TokenBucket[];
  /** Whether to attach a Bearer token (partner API only). */
  auth: boolean;
  /** Bucket(s) to freeze on a 429 from this upstream. */
  penalize: TokenBucket[];
}

/** Decide which buckets + auth a target upstream needs. */
function planFor(target: URL): Plan {
  if (isPartnerApi(target)) {
    if (isManifest(target)) {
      return { acquire: [buckets.global, buckets.manifest], auth: true, penalize: [buckets.global, buckets.manifest] };
    }
    return { acquire: [buckets.global], auth: true, penalize: [buckets.global] };
  }
  // Ungated hosts (oai/catalogue/data.bnf.fr): politeness bucket, no auth, NOT
  // counted against the partner 300/min.
  return { acquire: [buckets.external], auth: false, penalize: [buckets.external] };
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer | string): void {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { "content-type": contentType, "content-length": String(buf.length) });
  res.end(buf);
}

async function readJsonBody(req: IncomingMessage): Promise<{ url?: string; accept?: string }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw) as { url?: string; accept?: string };
}

async function handleFetch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: { url?: string; accept?: string };
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return send(res, 400, "text/plain", `bad request: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!payload.url) return send(res, 400, "text/plain", "missing 'url'");

  let target: URL;
  try {
    target = new URL(payload.url);
  } catch {
    return send(res, 400, "text/plain", `invalid url: ${payload.url}`);
  }
  if (!isAllowedUpstream(target)) {
    return send(res, 403, "text/plain", `upstream not allowed (only *.bnf.fr): ${target.host}`);
  }

  const plan = planFor(target);
  for (const b of plan.acquire) await b.acquire();

  const headers: Record<string, string> = {
    accept: payload.accept ?? "application/json, application/xml, */*",
  };
  if (plan.auth) {
    try {
      headers.authorization = await getAuthHeader();
    } catch (e) {
      // Token mint failed — surface as 502 so the caller treats it as transient.
      return send(res, 502, "text/plain", `token error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let upstream: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    upstream = await undiciFetch(target, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (e) {
    return send(res, 502, "text/plain", `upstream fetch error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (upstream.status === 429) {
    const until = retryAfterToEpochMs(upstream.headers.get("retry-after") ?? undefined, 60_000);
    for (const b of plan.penalize) b.penalizeUntil(until);
    console.warn(`[broker] 429 from ${target.host}${target.pathname} — bucket frozen until ${new Date(until).toISOString()}`);
  }

  const bytes = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
  send(res, upstream.status, ct, bytes);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, "application/json", '{"ok":true}');
  }
  if (req.method === "POST" && req.url === "/fetch") {
    handleFetch(req, res).catch((e: unknown) => {
      send(res, 500, "text/plain", `broker error: ${e instanceof Error ? e.message : String(e)}`);
    });
    return;
  }
  send(res, 404, "text/plain", "not found");
});

server.listen(config.port, () => {
  console.error(
    `[broker] listening on :${config.port} — api=${config.apiBaseUrl} ` +
      `caps: global=${config.globalRpm}/min manifest=${config.manifestRpm}/min ext=${config.externalRpm}/min`,
  );
});
