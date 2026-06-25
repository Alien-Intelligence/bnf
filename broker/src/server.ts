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
 *   POST /fetch       {"url": "...", "accept": "..."}  -> upstream status + body verbatim
 *   GET  /health      -> {"ok": true}
 *   GET  /calls.csv   -> CSV of every /fetch outcome (rate-limit analysis);
 *                        `?reset=1` clears the buffer after returning it.
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
import { callCount, recordCall, resetCalls, toCsv } from "./calls.js";
import { RateWaitTimeoutError, retryAfterToEpochMs, TokenBucket } from "./rate.js";
import { getAuthHeader, invalidateToken } from "./token.js";

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

/** Request body exceeded `maxBodyBytes` → mapped to HTTP 413. */
class BodyTooLargeError extends Error {}
/** Request body read exceeded `bodyReadTimeoutMs` → mapped to HTTP 408. */
class BodyTimeoutError extends Error {}

/**
 * Read + parse the JSON body with a hard byte cap and a read timeout. The
 * broker's own clients POST a tiny `{url, accept}`; bounding both size and time
 * stops a malformed/slow-loris request from growing memory or pinning the
 * connection open on this single-replica service (§14 unbounded await).
 */
function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ url?: string; accept?: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      cleanup();
      req.destroy();
      reject(new BodyTimeoutError(`body read exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > maxBytes) {
        cleanup();
        req.destroy();
        reject(new BodyTooLargeError(`body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => {
      cleanup();
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      try {
        resolve(JSON.parse(raw) as { url?: string; accept?: string });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    const onErr = (e: Error): void => {
      cleanup();
      reject(e);
    };
    function cleanup(): void {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onErr);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onErr);
  });
}

async function handleFetch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: { url?: string; accept?: string };
  try {
    payload = await readJsonBody(req, config.maxBodyBytes, config.bodyReadTimeoutMs);
  } catch (e) {
    const status = e instanceof BodyTooLargeError ? 413 : e instanceof BodyTimeoutError ? 408 : 400;
    return send(res, status, "text/plain", `bad request: ${e instanceof Error ? e.message : String(e)}`);
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
  // The rate bucket that governs this call (for the call log + analysis).
  const bucketLabel = isManifest(target) ? "manifest" : isPartnerApi(target) ? "global" : "external";
  const log = (status: number, note: string, waitMs: number, fetchMs: number, retryAfter: string | null): void => {
    recordCall({ ts: Date.now(), host: target.host, path: target.pathname, status, bucket: bucketLabel, authed: plan.auth, waitMs: Math.round(waitMs), fetchMs: Math.round(fetchMs), retryAfter, note });
  };

  const tAcquireStart = Date.now();
  try {
    for (const b of plan.acquire) await b.acquire(config.acquireMaxWaitMs);
  } catch (e) {
    if (e instanceof RateWaitTimeoutError) {
      // Bucket contended/frozen beyond the wait budget — shed with 429 so the
      // caller backs off (its retry policy treats 429 as transient) instead of
      // us queueing it behind a multi-minute freeze.
      log(429, "shed", Date.now() - tAcquireStart, 0, null);
      return send(res, 429, "text/plain", `broker rate budget exhausted: ${e.message}`);
    }
    throw e;
  }
  const waitMs = Date.now() - tAcquireStart;

  // Send the request, attaching auth for the partner API. On a partner-API 401
  // (our bearer was rejected though our clock thought it fresh — early
  // revocation, gateway restart, or a TTL shorter than `expires_in`) drop the
  // cached token and retry ONCE with a freshly minted one. A second 401 is a
  // real auth/scope failure and is mirrored to the caller untouched.
  const attemptFetch = async (
    forceFreshToken: boolean,
  ): Promise<Awaited<ReturnType<typeof undiciFetch>>> => {
    const headers: Record<string, string> = {
      accept: payload.accept ?? "application/json, application/xml, */*",
    };
    if (plan.auth) {
      if (forceFreshToken) invalidateToken();
      headers.authorization = await getAuthHeader();
    }
    return undiciFetch(target, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  };

  let upstream: Awaited<ReturnType<typeof undiciFetch>>;
  let reminted = false;
  const tFetchStart = Date.now();
  try {
    upstream = await attemptFetch(false);
    if (upstream.status === 401 && plan.auth) {
      console.warn(`[broker] 401 from ${target.host}${target.pathname} — re-minting token and retrying once`);
      reminted = true;
      upstream = await attemptFetch(true);
    }
  } catch (e) {
    // Token-mint failure or upstream transport failure — surface as 502 so the
    // caller treats it as transient and backs off.
    log(502, "upstream_error", waitMs, Date.now() - tFetchStart, null);
    return send(res, 502, "text/plain", `upstream/token error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const fetchMs = Date.now() - tFetchStart;

  const retryAfter = upstream.headers.get("retry-after");
  let note = reminted ? "remint" : "ok";
  if (upstream.status === 429) {
    const until = retryAfterToEpochMs(retryAfter ?? undefined, 60_000);
    for (const b of plan.penalize) b.penalizeUntil(until);
    console.warn(`[broker] 429 from ${target.host}${target.pathname} — bucket frozen until ${new Date(until).toISOString()}`);
    note = "freeze";
  } else if (upstream.status === 403 && !isPartnerApi(target)) {
    // An ungated host (gallica/oai/catalogue/data) 403 is a Cloudflare/captcha
    // IP throttle (no Retry-After), NOT an auth failure — freeze the politeness
    // bucket a fixed window so we stop hammering the blocked egress IP.
    // (A 403 from the partner API IS an auth/scope failure; freezing wouldn't
    // help, so it's mirrored through untouched.) See bnf-gallica-ip-throttle.
    const until = Date.now() + config.forbiddenBackoffMs;
    for (const b of plan.penalize) b.penalizeUntil(until);
    console.warn(`[broker] 403 (IP throttle) from ${target.host}${target.pathname} — bucket frozen ${config.forbiddenBackoffMs}ms`);
    note = "freeze_403";
  }
  log(upstream.status, note, waitMs, fetchMs, retryAfter);

  const bytes = Buffer.from(await upstream.arrayBuffer());
  const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
  send(res, upstream.status, ct, bytes);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, "application/json", '{"ok":true}');
  }
  // CSV of every /fetch outcome (timestamp, host, path, status, bucket, wait,
  // fetch, retry-after, note) for rate-limit analysis. `?reset=1` clears the
  // buffer AFTER returning the current snapshot, to start a fresh capture.
  if (req.method === "GET" && req.url?.startsWith("/calls.csv")) {
    const csv = toCsv();
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="broker-calls.csv"',
      "x-call-count": String(callCount()),
    });
    res.end(csv);
    if (req.url.includes("reset=1")) resetCalls();
    return;
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
