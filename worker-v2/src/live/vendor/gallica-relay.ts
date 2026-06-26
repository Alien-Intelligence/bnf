/**
 * Gallica fetch-relay client — DEMO STOPGAP, off by default.
 *
 * Cloudflare bot-fight-mode on gallica.bnf.fr blocks this worker by its
 * TLS/HTTP2 fingerprint (a real browser from the same IP passes). While the BnF
 * partner IP-allowlist (Cloudflare layer) is pending, setting GALLICA_RELAY_URL
 * routes every Gallica fetch through a small sidecar that borrows a real Firefox
 * handshake (curl_cffi), so legitimate low-volume partner ingestion can run.
 *
 * When GALLICA_RELAY_URL is unset (prod / normal), nothing here is used and the
 * worker talks to Gallica directly — no behaviour change. The worker's rate
 * limiter still gates volume BEFORE the relay, keeping it browser-polite. This
 * is NOT a path to scale: scale needs the real BnF API allowlist/quota.
 */
import { request } from "undici";

/** The relay base URL, or undefined when direct (the normal/prod path). */
export function gallicaRelayUrl(): string | undefined {
  const v = process.env.GALLICA_RELAY_URL;
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export interface RelayResult {
  status: number;
  bytes: Buffer;
  contentType: string;
}

/**
 * Fetch one URL through the relay. The relay mirrors the upstream status verbatim
 * (so the caller's status classification is unchanged) and returns the raw bytes
 * plus content-type. Throws on relay-transport failure (callers treat that as a
 * transient error, same as a direct network failure).
 */
export async function relayGet(
  targetUrl: string,
  accept: string | undefined,
  timeoutMs: number,
): Promise<RelayResult> {
  const relay = gallicaRelayUrl();
  if (!relay) {
    throw new Error("relayGet called but GALLICA_RELAY_URL is not set");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await request(relay, {
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
