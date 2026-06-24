// lib/bnf/gallica-relay.ts
// App-side Gallica fetch-relay client — DEMO STOPGAP, off by default.
//
// Cloudflare bot-fight-mode on gallica.bnf.fr blocks this server by its
// TLS/HTTP2 fingerprint — NOT by IP. A real browser from the same IP passes,
// and the `cf_clearance` cookie is bound to the IP+UA that solved the
// challenge, so injecting a captured browser cookie from the server is useless
// (verified: still 403). While the BnF partner IP-allowlist (Cloudflare layer)
// is pending, setting GALLICA_RELAY_URL routes every gallica.bnf.fr metadata
// fetch through a small sidecar that borrows a real Firefox handshake
// (curl_cffi) — the SAME relay the ingest worker uses (worker/gallica-relay.py).
//
// When GALLICA_RELAY_URL is unset (prod / normal), nothing here is used and the
// resolver talks to Gallica directly — no behaviour change. Only the
// Cloudflare-gated host (gallica.bnf.fr) is relayed; catalogue.bnf.fr and
// data.bnf.fr are not gated and stay direct. This is NOT a path to scale:
// scale needs the real BnF API allowlist/quota.
import "server-only"

import { fetch as undiciFetch } from "undici"

import { env } from "@/lib/env"
import { withTimeout } from "@/lib/mcp/abort"

/** The configured relay base URL, or undefined when direct (the normal/prod path). */
export function gallicaRelayUrl(): string | undefined {
  const v = env.GALLICA_RELAY_URL
  return v && v.trim() !== "" ? v.trim() : undefined
}

/**
 * Whether `url` must traverse the relay: only when a relay is configured AND the
 * target is the Cloudflare-gated Gallica host. A non-gallica host (catalogue /
 * data.bnf.fr) or an unparseable URL stays on the direct path.
 */
export function shouldRelay(url: string): boolean {
  if (!gallicaRelayUrl()) return false
  try {
    return new URL(url).hostname === "gallica.bnf.fr"
  } catch {
    return false
  }
}

/** Upstream status + decoded body, as returned through the relay. */
export interface RelayTextResult {
  status: number
  body: string
}

/**
 * Fetch one URL through the relay. The relay mirrors the upstream status
 * verbatim, so the caller's status classification is identical to the direct
 * path. Throws on relay-transport failure (the caller treats that as a
 * transient error, same as a direct network failure).
 */
export async function relayGetText(
  targetUrl: string,
  accept: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RelayTextResult> {
  const relay = gallicaRelayUrl()
  if (!relay) {
    throw new Error("relayGetText called but GALLICA_RELAY_URL is not set")
  }
  const res = await undiciFetch(relay, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: targetUrl, accept }),
    signal: withTimeout(signal, timeoutMs),
  })
  return { status: res.status, body: await res.text() }
}
