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
  } finally {
    clearTimeout(timer);
  }
}
