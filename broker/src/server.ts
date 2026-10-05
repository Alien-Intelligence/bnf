/**
 * BnF broker — the single egress chokepoint for all BnF traffic.
 *
 * Generalises the demo `gallica-relay` into a real gateway: it owns the OAuth
 * token (single-flight), enforces the BnF ingestion subscription's rate model
 * (a global cap, one quota per partner API, the per-IP manifest sub-limit —
 * plan.ts) plus a politeness bucket for ungated hosts, and centralises
 * 429/Retry-After backoff. The BnF KEY/SECRET live ONLY here — the app and
 * worker hold no BnF credentials, they just POST a fetch request and get the
 * upstream status + bytes verbatim.
 *
 * Contract (mirrors the relay so clients stay trivial):
 *   POST /fetch       {"url": "...", "accept": "..."}  -> upstream status + body verbatim
 *                     (403 for a non-*.bnf.fr host or an unclassified partner path,
 *                      429 when a bucket sheds the request)
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

import { isAllowedUpstream } from "./config.js";
import { config, partnerApiHost } from "./env.js";
import { truncatedBodyError } from "./body.js";
import { CallLog } from "./calls.js";
import { BUCKET_NAMES, createBuckets, planFor, type BucketName } from "./plan.js";
import { acquireAll, BucketShedError, retryAfterToEpochMs } from "./rate.js";
import { getAuthHeader, invalidateToken } from "./token.js";

/** The live buckets — every one on the default monotonic clock acquireAll uses. */
const buckets = createBuckets(config.rates);
const monotonicNow = (): number => performance.now();
const calls = new CallLog(config.callsLogSize);

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

  const plan = planFor(target, partnerApiHost);
  if (plan.kind === "reject") {
    // A partner-host path outside every known BnF API: never charged to a
    // guessed bucket, never sent on `global` alone (it could breach a quota we
    // do not model). Loud, because it means a client grew a new endpoint.
    console.error(`[broker] unclassified partner-API path rejected: ${target.pathname}`);
    calls.record({ ts: Date.now(), host: target.host, path: target.pathname, status: 403, bucket: null, authed: false, waitMs: 0, fetchMs: 0, retryAfter: null, note: "unclassified", acquired: [], shedBy: null });
    return send(res, 403, "text/plain", `unclassified partner-API path: ${target.pathname}`);
  }
  const log = (status: number, note: string, waitMs: number, fetchMs: number, retryAfter: string | null, shedBy: BucketName | null = null): void => {
    calls.record({ ts: Date.now(), host: target.host, path: target.pathname, status, bucket: plan.label, authed: plan.auth, waitMs: Math.round(waitMs), fetchMs: Math.round(fetchMs), retryAfter, note, acquired: plan.acquire, shedBy });
  };

  const tAcquireStart = Date.now();
  try {
    await acquireAll(
      plan.acquire.map((name) => [name, buckets[name]] as const),
      config.acquireMaxWaitMs,
      monotonicNow,
    );
  } catch (e) {
    if (e instanceof BucketShedError) {
      // One bucket of the plan is contended/frozen beyond the request's single
      // wait budget — shed with 429 so the caller backs off (its retry policy
      // treats 429 as transient) instead of us queueing it behind a freeze. The
      // tokens the plan had already taken were refunded (acquireAll).
      const shedBy = BUCKET_NAMES.find((b) => b === e.shedBy) ?? null;
      log(429, "shed", Date.now() - tAcquireStart, 0, null, shedBy);
      return send(res, 429, "text/plain", `broker rate budget exhausted (${e.shedBy}): ${e.message}`);
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
    // The most specific bucket only, never `global` (plan.ts planFor).
    const until = retryAfterToEpochMs(retryAfter ?? undefined, 60_000);
    buckets[plan.penalize].penalizeUntil(until);
    console.warn(`[broker] 429 from ${target.host}${target.pathname} — bucket ${plan.penalize} frozen until ${new Date(until).toISOString()}`);
    note = "freeze";
  } else if (upstream.status === 403 && !plan.auth) {
    // An ungated host (gallica/oai/catalogue/data) 403 is a Cloudflare/captcha
    // IP throttle (no Retry-After), NOT an auth failure — freeze the politeness
    // bucket a fixed window so we stop hammering the blocked egress IP.
    // (A 403 from the partner API IS an auth/scope failure; freezing wouldn't
    // help, so it's mirrored through untouched.) See bnf-gallica-ip-throttle.
    const until = Date.now() + config.forbiddenBackoffMs;
    buckets[plan.penalize].penalizeUntil(until);
    console.warn(`[broker] 403 (IP throttle) from ${target.host}${target.pathname} — bucket frozen ${config.forbiddenBackoffMs}ms`);
    note = "freeze_403";
  }
  log(upstream.status, note, waitMs, fetchMs, retryAfter);

  const bytes = Buffer.from(await upstream.arrayBuffer());
  // Truncation guard — see body.ts for the incident this prevents. A mismatch
  // between the buffered body and the upstream's declared content-length is a
  // transport failure the caller must retry (502), never a body to mirror.
  // `content-encoding` must be passed too: undici decodes the body before
  // arrayBuffer() resolves, so on a compressed response the buffer is the
  // decoded size while content-length is the encoded size. Without it the guard
  // read every gzip'd upstream as truncated — see body.ts.
  const truncated = truncatedBodyError(
    bytes.length,
    upstream.headers.get("content-length"),
    upstream.headers.get("content-encoding"),
  );
  if (truncated) {
    log(502, "truncated_upstream", waitMs, fetchMs, retryAfter);
    return send(res, 502, "text/plain", truncated);
  }
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
    const csv = calls.toCsv();
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="broker-calls.csv"',
      "x-call-count": String(calls.size()),
    });
    res.end(csv);
    if (req.url.includes("reset=1")) calls.reset();
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
  const caps = BUCKET_NAMES.map((b) => `${b}=${config.rates[b].rpm}/${config.rates[b].burst}`).join(" ");
  console.error(`[broker] listening on :${config.port} — api=${config.apiBaseUrl} caps (rpm/burst): ${caps}`);
});
