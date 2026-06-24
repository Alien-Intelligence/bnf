// lib/bnf/broker-client.ts
// App-side client for the BnF broker (broker/ service).
//
// The broker is the single egress chokepoint for all BnF traffic: it owns the
// OAuth token and enforces the shared 300/min global + 12/min-per-IP manifest +
// politeness rate caps that the app resolver and the ingest worker must jointly
// respect. When `BNF_BROKER_URL` is set, the resolver POSTs its fetches here
// instead of talking to BnF directly; the broker mirrors the upstream status
// verbatim, so the caller's classification is identical. Absent → callers fall
// back to their direct transport (dev without the broker).
import "server-only"

import { fetch as undiciFetch } from "undici"

import { env } from "@/lib/env"
import { withTimeout } from "@/lib/mcp/abort"

/** The configured broker base URL, or undefined when not deployed. */
export function brokerUrl(): string | undefined {
  const v = env.BNF_BROKER_URL
  return v && v.trim() !== "" ? v.trim() : undefined
}

/** Upstream status + decoded body, as returned through the broker. */
export interface BrokerTextResult {
  status: number
  body: string
}

/**
 * Fetch one BnF URL through the broker. The broker selects the auth + rate
 * bucket from the URL (partner API → Bearer + global cap; manifest → + manifest
 * cap; ungated oai/catalogue/data → politeness bucket, no auth) and mirrors the
 * upstream status verbatim. Throws on broker-transport failure (treated as
 * transient, same as a direct network error).
 */
export async function brokerGetText(
  targetUrl: string,
  accept: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<BrokerTextResult> {
  const broker = brokerUrl()
  if (!broker) {
    throw new Error("brokerGetText called but BNF_BROKER_URL is not set")
  }
  const res = await undiciFetch(`${broker.replace(/\/$/, "")}/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: targetUrl, accept }),
    signal: withTimeout(signal, timeoutMs),
  })
  return { status: res.status, body: await res.text() }
}
