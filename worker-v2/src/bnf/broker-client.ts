/**
 * BnF broker client (V2 worker side) — ported from V1's
 * worker/src/prepare/broker-client.ts.
 *
 * The broker (broker/ service) is the single egress chokepoint for all BnF
 * traffic: it owns the OAuth token and enforces the shared 300/min global +
 * 12/min-per-IP manifest + politeness rate caps. Every BnF fetch in V2 goes
 * through it; the broker selects auth + rate bucket from the URL and mirrors
 * the upstream status + bytes verbatim.
 *
 * V1 wrapped every call in `withFetchPermit` (the process-global fetch gate)
 * so the per-doc monolith couldn't blow the broker's concurrency. V2 drops
 * that wrapper deliberately: the fetch STAGE owns concurrency (pg-boss work
 * limit) and rate (RateGate), so bounding here too would double-bound and
 * starve the broker's bucket. The client is now a thin transport — status +
 * raw bytes + content-type.
 */
import { request } from "undici";

/** The configured broker base URL, or undefined when not deployed. */
export function brokerUrl(): string | undefined {
  const v = process.env.BNF_BROKER_URL;
  return v && v.trim() !== "" ? v.trim().replace(/\/$/, "") : undefined;
}

export interface BrokerResult {
  status: number;
  bytes: Buffer;
  contentType: string;
}

/**
 * Fetch one BnF URL through the broker. Throws on broker-transport failure
 * (callers treat that as a transient error, same as a direct network failure).
 *
 * No concurrency wrapper here — see the file header: the fetch stage is the
 * single concurrency + rate bound in V2.
 */
export async function brokerGet(
  targetUrl: string,
  accept: string | undefined,
  timeoutMs: number,
): Promise<BrokerResult> {
  const broker = brokerUrl();
  if (!broker) {
    throw new Error("brokerGet called but BNF_BROKER_URL is not set");
  }
  // One quick reconnect on a connection-level error. The broker is a SINGLE
  // replica with strategy:Recreate, so a deploy (even an app-only one) blips it
  // offline for a few seconds — every in-flight fetch sees ECONNREFUSED. A single
  // short retry absorbs that window instead of failing the folio and burning the
  // pg-boss retry budget. Only connection errors retry here; a timeout (the abort)
  // is left to the stage, since retrying it immediately would just re-hit it.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Arm the timeout around the request itself. Queue time is owned upstream by
    // the fetch stage's RateGate, so it never counts against this budget.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await request(`${broker}/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: targetUrl, accept }),
        signal: controller.signal,
      });
      const bytes = Buffer.from(await res.body.arrayBuffer());
      const contentType =
        (res.headers["content-type"] as string | undefined) ??
        "application/octet-stream";
      return { status: res.statusCode, bytes, contentType };
    } catch (err) {
      lastErr = err;
      if (attempt < 2 && isConnectionError(err)) {
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** A connection-level transport failure (broker down/restarting), not a timeout. */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
  const codes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
  ]);
  return (
    (typeof code === "string" && codes.has(code)) ||
    (typeof causeCode === "string" && codes.has(causeCode))
  );
}
