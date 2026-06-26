/**
 * Vision client — describes a Gallica image (estampe, carte, affiche,
 * photographie, …) as structured French metadata for RAG indexing.
 *
 * Two providers, tried in the order set by VISION_PRIMARY (holo|gemini):
 *   - Scaleway Holo2 (`HOLO_MODEL`), OpenAI-compatible API.
 *   - Google AI Gemma (`GEMINI_VISION_MODEL`, default gemma-4-31b-it).
 * Whichever is secondary is used when the primary throws or returns
 * unparseable output. Scaleway's Holo endpoint has been seen to drop every
 * chat request ("Premature close") during outages — set VISION_PRIMARY=gemini
 * to skip it entirely while it's down; the fallback keeps ingestion working.
 *
 * Vendored into the worker on purpose (was a dynamic import into a sibling
 * sandbox dir that the container doesn't ship — the original `holo_failed`
 * cause). Both providers share one prompt/schema and return one shape so the
 * rest of the pipeline is provider-agnostic.
 */
import { GoogleGenAI } from "@google/genai";
import { Agent, request } from "undici";

import { genai, google, openrouter } from "./env.js";
import { brokerGet, brokerUrl } from "./broker-client.js";
import { gallicaRelayUrl, relayGet } from "./gallica-relay.js";
import { gallicaRateLimit } from "./rate-limiter.js";

// Holo is called over RAW fetch, NOT the OpenAI SDK. The OpenAI Node SDK
// (v4) is incompatible with Scaleway's chat endpoint — every request (text or
// image) comes back "Premature close" (the server resets the connection on
// the SDK's headers/body framing), while a plain fetch with a JSON string body
// returns 200. Verified head-to-head, same process. Python/httpx works too.
// Dedicated dispatcher with short keep-alive so a dropped/half-dead socket is
// never reused under concurrent load (same lesson as the cluster HTTP client).
const holoDispatcher = new Agent({
  connect: { timeout: 15_000 },
  keepAliveTimeout: 500,
  keepAliveMaxTimeout: 500,
  pipelining: 0,
});

interface HoloChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

let cachedGemini: GoogleGenAI | null = null;

/** Lazily built so Holo-only / text-only runs never need GOOGLE_AI_API_KEY. */
function geminiClient(): GoogleGenAI {
  if (cachedGemini) return cachedGemini;
  cachedGemini = new GoogleGenAI({ apiKey: google.apiKey() });
  return cachedGemini;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Catalogue context handed to the model as ground truth (never contradicted). */
export interface DocumentContext {
  ark?: string;
  title?: string;
  creator?: string;
  date?: string;
  docType?: string;
}

/** Structured description the model returns for one image. */
export interface ImageDescription {
  titreApparent: string | null;
  typeVisuel: string;
  sujet: string;
  scenesEtElements: string[];
  legendes: string[];
  echelle: string | null;
  motsCles: string[];
  descriptionLongue: string;
}

const SYSTEM_PROMPT = `Tu es un archiviste de la Bibliothèque nationale de France
spécialisé dans la description de documents iconographiques (plans, cartes,
estampes, photographies, affiches, dessins, enluminures). Tu décris les images
en français, de façon factuelle et précise, pour alimenter un index de
recherche RAG destiné aux chercheurs et librairies.

Règles :
- Le texte sera indexé pour la recherche plein-texte ET la recherche sémantique.
  Sois riche en mots-clés et en termes spécialisés que les chercheurs
  utiliseraient.
- N'invente jamais de date, d'auteur ou d'attribution. Si la BnF te donne ces
  informations dans le contexte, tu les utilises ; sinon tu décris uniquement
  ce que tu vois.
- N'invente jamais l'état de conservation ; ne le décris pas.
- Transcris tout texte lisible (titres, cartouches, légendes, mentions
  d'imprimerie, dates inscrites, numéros de planche).

Tu réponds UNIQUEMENT par un objet JSON valide, sans texte avant ni après,
sans bloc de code markdown. Le schéma exact est :

{
  "titreApparent": string | null,    // titre lisible sur le document lui-même (pas la fiche BnF), ou null si rien de lisible
  "typeVisuel": string,              // "plan urbain", "carte géographique", "estampe", "gravure", "lithographie", "photographie", "dessin technique", "dessin architectural", "affiche", "enluminure", "portrait", etc.
  "sujet": string,                   // 1-2 phrases : de quoi l'image traite-t-elle ?
  "scenesEtElements": string[],      // 5-15 éléments visuels distincts (personnages, lieux, objets, motifs, composition)
  "legendes": string[],              // toutes les inscriptions textuelles visibles, transcrites verbatim (titre, sous-titre, mentions d'imprimerie, légendes, numéros)
  "echelle": string | null,          // échelle indiquée pour cartes/plans/dessins techniques, ou null
  "motsCles": string[],              // 8-15 mots-clés français pour la recherche (lieux, personnes, courants artistiques, techniques, thèmes)
  "descriptionLongue": string        // description dense de 200-400 mots, riche en termes que les chercheurs utiliseraient pour retrouver ce document
}`;

function buildUserPrompt(ctx?: DocumentContext): string {
  if (!ctx || Object.values(ctx).every((v) => !v)) {
    return `Décris cette image issue d'un fonds patrimonial français.
Retourne UNIQUEMENT le JSON conforme au schéma. Pas de markdown.`;
  }

  const lines = ["Contexte fourni par la BnF (vérité terrain — utilise-le, ne le contredis pas) :"];
  if (ctx.title) lines.push(`- Titre catalogué : ${ctx.title}`);
  if (ctx.creator) lines.push(`- Auteur/créateur : ${ctx.creator}`);
  if (ctx.date) lines.push(`- Date : ${ctx.date}`);
  if (ctx.docType) lines.push(`- Type catalogué : ${ctx.docType}`);
  if (ctx.ark) lines.push(`- ARK : ${ctx.ark}`);
  lines.push("");
  lines.push(
    "Décris cette image en t'appuyant sur ce contexte pour la cohérence des mots-clés et du vocabulaire.",
  );
  lines.push("Retourne UNIQUEMENT le JSON conforme au schéma. Pas de markdown.");
  return lines.join("\n");
}

export interface FetchedImage {
  dataUrl: string;
  base64: string;
  mimeType: string;
  imageBytes: number;
}

/**
 * Image fetch failed with a non-2xx upstream status. Carries the status so
 * callers can distinguish a permanent, doc-wide condition (a 4xx — e.g. a size
 * the server rejects, or an access-restricted image) from a transient blip and
 * fail fast instead of attempting every folio.
 */
export class ImageFetchError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ImageFetchError";
  }
}

/**
 * Fetch an image as a base64 data-URL, honouring the broker / relay / rate-limit
 * path (see the body). Exported so the Mistral OCR path reuses the exact same
 * politeness controls instead of hitting Gallica raw — never hand a Gallica URL
 * to a third-party OCR service, it bypasses our throttle and gets IP-blocked.
 */
export async function fetchImage(url: string): Promise<FetchedImage> {
  const isBnf = /(^|\.)bnf\.fr$/i.test(new URL(url).hostname);
  let mimeType: string;
  let buffer: Buffer;
  // Broker path (partner API): the broker owns auth + the shared rate budget,
  // so we do NOT acquire a local bucket. Takes precedence over the relay.
  if (isBnf && brokerUrl()) {
    const r = await brokerGet(url, "image/jpeg,image/png,image/*;q=0.9", 60_000);
    if (r.status < 200 || r.status >= 300) {
      throw new ImageFetchError(r.status, `Image fetch failed: ${r.status} (broker) for ${url}`);
    }
    return finalizeImage(r.bytes, r.contentType || "image/jpeg");
  }
  // IIIF image fetches go through the GENERAL Gallica limiter (generous, not
  // the strict 5/min ALTO bucket) — a politeness cap, not a serializer, so
  // many image docs can be described in parallel.
  if (isBnf) {
    await gallicaRateLimit.acquire();
  }
  // Demo stopgap: route Gallica image fetches through the browser-handshake
  // relay when configured (see gallica-relay.ts). Non-Gallica URLs never relay.
  const isGallica = isBnf;
  if (isGallica && gallicaRelayUrl()) {
    const r = await relayGet(url, "image/jpeg,image/png,image/*;q=0.9", 60_000);
    if (r.status < 200 || r.status >= 300) {
      throw new ImageFetchError(r.status, `Image fetch failed: ${r.status} (relay) for ${url}`);
    }
    mimeType = r.contentType || "image/jpeg";
    buffer = r.bytes;
  } else {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "bnf-ingest/0.1 (leo@alien.club)",
        Accept: "image/jpeg,image/png,image/*;q=0.9",
      },
    });
    if (!res.ok) {
      throw new ImageFetchError(res.status, `Image fetch failed: ${res.status} ${res.statusText} for ${url}`);
    }
    mimeType = res.headers.get("content-type") ?? "image/jpeg";
    buffer = Buffer.from(await res.arrayBuffer());
  }
  return finalizeImage(buffer, mimeType);
}

/** Pack fetched image bytes into the base64 data-URL shape the vision call needs. */
function finalizeImage(buffer: Buffer, mimeType: string): FetchedImage {
  const base64 = buffer.toString("base64");
  return {
    dataUrl: `data:${mimeType};base64,${base64}`,
    base64,
    mimeType,
    imageBytes: buffer.length,
  };
}

export interface DescribeOptions {
  context?: DocumentContext;
  model?: string;
  maxTokens?: number;
}

export interface DescribeResult {
  parsed: ImageDescription | null;
  raw: string;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  imageBytes: number;
  model: string;
  /** Which provider produced this result. */
  provider: "openrouter" | "holo" | "gemini";
}

/**
 * Describe an image across the two providers (order set by VISION_PRIMARY).
 *
 * Retry shape (worker-v2 divergence from V1): the retry loop is at the PAIR
 * level, not per-provider. Each ROUND tries the primary ONCE; on ANY error it
 * falls straight to the secondary ONCE. So a dead primary costs one failed call,
 * not three, before the fallback runs:
 *
 *   round: primary → err → secondary → ok?  return        (the happy fallback)
 *                                    → err? → wait & loop  (both down → retry)
 *
 * A provider that RESPONDS but returns unparseable JSON is "good enough" (the
 * caller falls back to the raw text), so it returns without looping. Only a round
 * where BOTH providers THROW backs off and retries, up to MAX_ROUNDS; after that
 * it throws and the caller skips the canvas.
 */
export async function describeImage(
  imageUrl: string,
  options: DescribeOptions = {},
): Promise<DescribeResult> {
  const img = await fetchImage(imageUrl);

  // Fixed fallback chain: OpenRouter (reliable primary) → Scaleway Holo →
  // Google Gemma. First provider to RESPOND wins; a round backs off + retries
  // only if ALL THREE throw (see the loop below).
  const providers: Array<{ name: string; run: () => Promise<DescribeResult> }> = [
    { name: "OpenRouter", run: () => describeViaOpenRouter(img, options) },
    { name: "Holo", run: () => describeViaHolo(img, options) },
    { name: "Gemini", run: () => describeViaGemini(img, options) },
  ];

  const MAX_ROUNDS = 3;
  let lastErr: unknown;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let unparseable: DescribeResult | null = null;
    for (const p of providers) {
      try {
        const result = await p.run();
        if (result.parsed) return result; // got JSON → done
        unparseable = result; // responded but no JSON → try the other provider
        console.warn(`[vision] ${p.name} returned unparseable JSON`);
      } catch (err) {
        lastErr = err;
        console.warn(
          `[vision] ${p.name} failed (${
            err instanceof Error ? err.message : String(err)
          }); falling through`,
        );
      }
    }
    // At least one provider responded (just not as JSON) → use it (raw fallback).
    if (unparseable) return unparseable;
    // Both providers threw this round → back off and retry the pair.
    if (round < MAX_ROUNDS) {
      const backoffMs = 1000 * Math.pow(2, round - 1);
      console.warn(
        `[vision] both providers failed (round ${round}/${MAX_ROUNDS}); retrying in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("[vision] all providers failed after retries");
}

/** How long to wait before retrying a rate-limited / transient OpenRouter call. */
function openrouterTimeoutMs(): number {
  const raw = process.env.OPENROUTER_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90_000;
}
function openrouterMaxAttempts(): number {
  const raw = process.env.OPENROUTER_MAX_ATTEMPTS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

/** Header value → first string (undici headers are string | string[] | undefined). */
function headerStr(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * How long to back off after a 429, derived from the provider's own signal so we
 * ride the rate edge instead of guessing: `Retry-After` (delta-seconds or HTTP
 * date) first, then `X-RateLimit-Reset` (epoch ms, OpenRouter's convention). Falls
 * back to the caller's jittered exponential backoff when neither is present.
 * Capped so a far-future reset can't park a worker slot indefinitely.
 */
function retryAfterMs(headers: Record<string, string | string[] | undefined>): number | null {
  const cap = 30_000;
  const ra = headerStr(headers["retry-after"]);
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(cap, Math.max(0, secs * 1000));
    const when = Date.parse(ra);
    if (Number.isFinite(when)) return Math.min(cap, Math.max(0, when - Date.now()));
  }
  const reset = headerStr(headers["x-ratelimit-reset"]);
  if (reset) {
    const epochMs = Number(reset);
    if (Number.isFinite(epochMs)) {
      // Heuristic: a 10-digit value is epoch SECONDS, 13-digit is ms.
      const ms = epochMs < 1e12 ? epochMs * 1000 : epochMs;
      return Math.min(cap, Math.max(0, ms - Date.now()));
    }
  }
  return null;
}

/** Jittered exponential backoff for transient OpenRouter retries (no header hint). */
function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 500 * 2 ** (attempt - 1));
  return base + Math.floor(base * 0.25 * (attempt % 3)); // small deterministic jitter
}

/**
 * PRIMARY provider: OpenRouter (OpenAI-compatible /chat/completions). Raw undici.
 * gemini-2.5-flash by default (OPENROUTER_VISION_MODEL overrides).
 *
 * Hardened (pass 2): OpenRouter is the bottleneck lane and the paid key has NO
 * per-key RPM cap — the only ceiling is upstream provider capacity, surfaced as
 * 429s/timeouts. So this owns a short IN-PROVIDER retry loop for *banal* errors
 * before giving up to the chain's Holo/Gemini fallback:
 *   - 429        → honor Retry-After / X-RateLimit-Reset (else jittered backoff), retry
 *   - 5xx        → backoff, retry
 *   - abort/timeout → backoff, retry (don't abandon a slow-but-alive call)
 *   - 200 w/ {error} envelope or empty content → backoff, retry (a banal blank)
 *   - other 4xx  → throw immediately (real client error; chain falls to Holo/Gemini)
 * After the attempts are spent it throws, and describeImage's chain takes over.
 * Errors always carry status + a body slice so no failure logs an empty reason.
 */
async function describeViaOpenRouter(
  img: FetchedImage,
  options: DescribeOptions,
): Promise<DescribeResult> {
  const model = options.model ?? openrouter.model();
  const url = `${openrouter.baseUrl().replace(/\/+$/, "")}/chat/completions`;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: buildUserPrompt(options.context) },
        { type: "image_url", image_url: { url: img.dataUrl } },
      ],
    },
  ];
  // 8192 bounds a runaway: the legitimate structured description is ~500-1500
  // tokens, so 8192 is generous headroom AND caps the cost/latency of a degenerate
  // generation (gemini-2.5-flash occasionally loops on a dense folio and runs to the
  // ceiling → finish_reason "length" → unparseable). response_format constrains the
  // decoder to syntactically-valid JSON (kills the prose-wrap failure mode).
  const maxTokens = options.maxTokens ?? 8192;
  const bodyFor = (temperature: number): string =>
    JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      top_p: 0.95,
      response_format: { type: "json_object" },
    });
  const headers = {
    authorization: `Bearer ${openrouter.apiKey()}`,
    "content-type": "application/json",
    "x-title": "BnF Corpus Research",
  };

  const maxAttempts = openrouterMaxAttempts();
  const timeoutMs = openrouterTimeoutMs();
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // First attempt is low-temperature (faithful, deterministic). A retry RAISES
    // the temperature: the common cause of a finish_reason=length truncation is a
    // degenerate repetition loop, and bumping temperature is the standard way to
    // break out of it (a lower temperature would re-enter the same loop).
    const temperature = attempt === 1 ? 0.3 : 0.8;
    const body = bodyFor(temperature);
    const start = Date.now();
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Transport-level failure (abort/timeout, ECONNRESET, …). Banal — retry.
      lastErr = new Error(
        `OpenRouter transport: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      );
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }

    const text = await res.body.text();
    const status = res.statusCode;

    if (status === 429 || status >= 500) {
      lastErr = new Error(`OpenRouter HTTP ${status}: ${text.slice(0, 200)}`);
      if (attempt < maxAttempts) {
        const hinted = status === 429 ? retryAfterMs(res.headers) : null;
        await sleep(hinted ?? backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }
    if (status < 200 || status >= 300) {
      // A real client error (auth, bad request, model unavailable) — retrying
      // won't help. Throw so the chain falls straight to Holo/Gemini.
      throw new Error(`OpenRouter HTTP ${status}: ${text.slice(0, 200)}`);
    }

    let data: HoloChatResponse & { error?: { message?: string; code?: unknown } };
    try {
      data = JSON.parse(text);
    } catch {
      // 200 but unparseable body — banal, retry; if exhausted let the chain try others.
      lastErr = new Error(`OpenRouter 200 non-JSON body: ${text.slice(0, 200)}`);
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }

    // OpenRouter can return 200 with an {error} envelope (upstream hiccup). Banal — retry.
    if (data.error) {
      lastErr = new Error(
        `OpenRouter 200 error envelope: ${String(data.error.message ?? JSON.stringify(data.error)).slice(0, 200)}`,
      );
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }

    const latencyMs = Date.now() - start;
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const raw = msg?.content || msg?.reasoning_content || msg?.reasoning || "";
    // Truncated mid-JSON (hit max_tokens) → unparseable; banal, retry.
    if (choice?.finish_reason === "length" && !tryParseJson(raw)) {
      lastErr = new Error(`OpenRouter truncated (finish_reason=length, ${raw.length} chars)`);
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }
    if (!raw.trim()) {
      // Empty completion — banal; retry, then defer to the chain rather than emit a blank page.
      lastErr = new Error(`OpenRouter returned empty content (model ${model})`);
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }

    return {
      parsed: tryParseJson(raw),
      raw,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
      latencyMs,
      imageBytes: img.imageBytes,
      model,
      provider: "openrouter",
    };
  }

  throw lastErr ?? new Error("OpenRouter: exhausted attempts");
}

/** FALLBACK 1: Scaleway Holo2 via the OpenAI-compatible API. */
async function describeViaHolo(
  img: FetchedImage,
  options: DescribeOptions,
): Promise<DescribeResult> {
  const model = options.model ?? genai.holoModel();
  const url = `${genai.baseUrl().replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: buildUserPrompt(options.context) },
          { type: "image_url", image_url: { url: img.dataUrl } },
        ],
      },
    ],
    max_tokens: options.maxTokens ?? 8192,
    temperature: 0.3,
    top_p: 0.95,
  });
  const headers = {
    authorization: `Bearer ${genai.apiKey()}`,
    "content-type": "application/json",
  };

  // Single attempt — describeImage owns the retry loop and the Gemini fallback,
  // so a Holo error throws straight out to it (no in-provider re-tries).
  const start = Date.now();
  const res = await request(url, {
    method: "POST",
    headers,
    body,
    dispatcher: holoDispatcher,
    // 30s, not 120s: when Holo is slow/down we want to fail fast and fall to
    // Gemini (a healthy Holo answers well under this). describeImage retries the
    // pair, so this is the per-call cost of a dead Holo — kept short on purpose.
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Holo HTTP ${res.statusCode}: ${text.slice(0, 150)}`);
  }
  const data = JSON.parse(text) as HoloChatResponse;

  const latencyMs = Date.now() - start;
  // Holo2 (a reasoning model) sometimes emits the JSON into `reasoning_content`
  // / `reasoning` rather than `content`. Try all three.
  const msg = data.choices?.[0]?.message;
  const raw = msg?.content || msg?.reasoning_content || msg?.reasoning || "";
  return {
    parsed: tryParseJson(raw),
    raw,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
    latencyMs,
    imageBytes: img.imageBytes,
    model,
    provider: "holo",
  };
}

/**
 * FALLBACK provider: Google AI Gemma. Gemma has no system role, so the system
 * prompt is folded into the single user text part. It's a reasoning model
 * (burns "thoughts" tokens) so the output budget must be generous.
 */
async function describeViaGemini(
  img: FetchedImage,
  options: DescribeOptions,
): Promise<DescribeResult> {
  const model = google.visionModel();
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserPrompt(options.context)}`;

  // Single attempt — describeImage owns the retry loop and provider fallback.
  const start = Date.now();
  const resp = await geminiClient().models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: img.mimeType, data: img.base64 } },
        ],
      },
    ],
    config: {
      // gemma-4-31b-it spends a large share of tokens on hidden reasoning,
      // so the budget must cover thoughts + the JSON answer.
      maxOutputTokens: options.maxTokens ?? 8192,
      temperature: 0.3,
      topP: 0.95,
    },
  });
  const raw =
    resp.text ??
    resp.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";
  const usage = {
    promptTokens: resp.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
  };

  return {
    parsed: tryParseJson(raw),
    raw,
    usage,
    latencyMs: Date.now() - start,
    imageBytes: img.imageBytes,
    model,
    provider: "gemini",
  };
}

function tryParseJson(text: string): ImageDescription | null {
  const trimmed = text.trim();
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped) as ImageDescription;
  } catch {
    // Fallback: a provider may wrap the JSON in prose ("Voici la description : {…}").
    // Extract the outermost balanced {…} object and try that. Cheap insurance for
    // the Holo/Gemini paths (OpenRouter is constrained by response_format).
    const obj = extractFirstJsonObject(stripped);
    if (obj) {
      try {
        return JSON.parse(obj) as ImageDescription;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Extract the first balanced top-level {…} from text, honoring strings/escapes. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
