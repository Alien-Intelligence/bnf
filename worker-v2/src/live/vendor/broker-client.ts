/**
 * BnF broker client (worker side) — twin of the app's lib/bnf/broker-client.ts.
 *
 * The broker (broker/ service) is the single egress chokepoint for all BnF
 * traffic: it owns the OAuth token and enforces the shared 300/min global +
 * 12/min-per-IP manifest + politeness rate caps that the worker and the app
 * resolver must jointly respect. When `BNF_BROKER_URL` is set, every BnF fetch
 * goes through it; the broker selects auth + rate bucket from the URL and
 * mirrors the upstream status + bytes verbatim. Absent → the worker falls back
 * to its legacy direct/relay path (dev without the broker).
 *
 * Shape mirrors `relayGet` (status + raw bytes + content-type) so it's a
 * drop-in at every call site.
 */
import { request } from "undici";

import { withFetchPermit } from "./fetch-gate.js";

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
  // The fetch gate is the worker's single concurrency bound for ALL broker
  // traffic (ALTO, OAI, manifest, SRU, images all flow through brokerGet). The
  // broker still owns the RATE; the gate only keeps its bucket fed continuously.
  // Acquire the permit BEFORE arming the timeout so queue time never counts
  // against the per-request budget (same rule as fetchText's rate-limiter).
  return withFetchPermit(async () => {
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
  });
}
