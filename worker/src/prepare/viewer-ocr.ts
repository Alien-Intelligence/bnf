/**
 * Gallica viewer-OCR harvester — fallback/primary OCR text source.
 *
 * Scrapes the public Gallica viewer's AJAX endpoint (the same call the page
 * viewer makes) for per-view OCR:
 *
 *   GET /services/ajax/mode/SINGLE/ark:/12148/<arkId>/f<N>.texteImage
 *
 * Why this exists: the official ALTO endpoint (RequestDigitalElement?E=ALTO)
 * is capped at ~5 req/min, which makes batch ingestion take days. This viewer
 * endpoint is not under that quota — it tolerates concurrency ~4 cleanly — so
 * it is used as the PRIMARY OCR source until BnF raises the ALTO quota. The
 * ALTO path (`getDocumentTextViaAlto`) remains the fallback if this
 * undocumented endpoint changes shape.
 *
 * Scope limit (by design, not a bug): for "indisponibles" documents only the
 * ~15% preview exposes OCR. That is the same limit the official API has —
 * restricted text exists nowhere — so a partial harvest is the correct,
 * complete result for such a document.
 *
 * Hard rules (see the harvester spec):
 *   - Read `currentPage.contenu[0]` ONLY. The previous/next/first/last nodes
 *     mirror the current page's OCR — reading them mis-attributes text.
 *   - Assert screenNumber === requested view (wrong folio → wrong citation).
 *   - Classify by `pageIsDisplayable`, never by a hardcoded page range.
 *   - 200 with no `currentPage` => the viewer shape changed; raise, never
 *     return empty-as-if-textless.
 */

import { gallicaRelayUrl, relayGet } from "./gallica-relay.js";

const GALLICA = "https://gallica.bnf.fr";

/** Browser-like headers — Gallica gates this AJAX endpoint on them. No cookie needed. */
function viewerHeaders(ark: string, folio: string): Record<string, string> {
  return {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${GALLICA}/ark:/12148/${ark}/${folio}.item`,
  };
}

export interface ViewerOcrPage {
  /** Gallica view index (1-based), from the response's screenNumber. */
  view: number;
  /** Preview page exposing OCR (true) vs restricted (false). */
  displayable: boolean;
  /** Cleaned OCR text, or null when a displayable page legitimately has none. */
  ocrText: string | null;
  /** OCR confidence % parsed from the disclaimer, when present. */
  ocrRate: number | null;
}

export interface ViewerOcrOptions {
  /** Loop bound. If omitted, read `nbTotalVues` from the first response. */
  totalViews?: number;
  /** Cap on views probed. */
  maxViews?: number;
  /** Concurrent requests. Spec: ≤ 4–6; 4 verified clean. */
  concurrency?: number;
  /** Per-request hard timeout. */
  perRequestTimeoutMs?: number;
  /** Whole-job wall-clock ceiling — no infinite default. */
  wallClockMs?: number;
  /** Politeness delay between a worker's requests. */
  interRequestDelayMs?: number;
}

export interface ViewerOcrResult {
  totalViews: number;
  pages: ViewerOcrPage[];
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const DEFAULTS = {
  // The viewer AJAX endpoint is not under the ALTO 5/min quota — it tolerates
  // healthy parallelism. Tunable via VIEWER_OCR_CONCURRENCY.
  concurrency: envInt("VIEWER_OCR_CONCURRENCY", 10),
  perRequestTimeoutMs: 15_000,
  wallClockMs: 30 * 60_000,
  interRequestDelayMs: envInt("VIEWER_OCR_DELAY_MS", 40),
  retries: 3,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** stringOCR (HTML) → plain text. Preserves paragraph breaks (the chunker's only structure). */
function cleanOcr(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseOcrRate(sousTitre: string | undefined | null): number | null {
  if (!sousTitre) return null;
  const m = /(\d+[.,]\d+)\s*%/.exec(sousTitre);
  return m ? Number(m[1]!.replace(",", ".")) : null;
}

interface FolioFetch {
  page: ViewerOcrPage;
  /** Present only on the first fetch we read it from. */
  nbTotalVues: number | null;
}

/** Fetch and parse one view. Retries 429/5xx/network; other 4xx is terminal. */
async function fetchFolio(
  ark: string,
  view: number,
  perRequestTimeoutMs: number,
  retries: number,
): Promise<FolioFetch> {
  const folio = `f${view}`;
  const url = `${GALLICA}/services/ajax/mode/SINGLE/ark:/12148/${ark}/${folio}.texteImage`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Demo stopgap: route through the browser-handshake relay when set, so
      // Cloudflare doesn't reject our fingerprint (see gallica-relay.ts).
      let status: number;
      let getBody: () => Promise<string>;
      if (gallicaRelayUrl()) {
        const r = await relayGet(
          url,
          "application/json, text/javascript, */*;q=0.8",
          perRequestTimeoutMs,
        );
        status = r.status;
        getBody = () => Promise.resolve(r.bytes.toString("utf8"));
      } else {
        const res = await fetch(url, {
          headers: viewerHeaders(ark, folio),
          signal: AbortSignal.timeout(perRequestTimeoutMs),
        });
        status = res.status;
        getBody = () => res.text();
      }
      if (status === 429 || status >= 500) {
        lastErr = new Error(`HTTP ${status}`);
        if (attempt < retries) await sleep(attempt * 1500);
        continue;
      }
      if (status < 200 || status >= 300) {
        // Other 4xx → terminal for this view.
        throw new Error(`Gallica viewer ${folio} -> HTTP ${status}`);
      }
      const body = await getBody();
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        lastErr = new Error("non-JSON viewer response");
        if (attempt < retries) await sleep(attempt * 1500);
        continue;
      }

      const cur = (json as VR)?.fragment?.contenu?.Visualizer?.affichage?.contenu
        ?.renderModel?.contenu?.currentPage?.contenu?.[0];
      if (!cur) {
        // 200 with no currentPage = the undocumented shape changed. Raise —
        // do NOT return empty as if the page were textless.
        throw new Error(
          `Gallica viewer shape changed for ${ark}/${folio}: currentPage missing. Payload head: ${body.slice(0, 200)}`,
        );
      }

      const screenNumber =
        typeof cur.screenNumber === "number" ? cur.screenNumber : null;
      if (screenNumber !== view) {
        // Wrong folio would mean wrong citation downstream — never accept it.
        throw new Error(
          `Gallica viewer folio mismatch: requested f${view}, got screenNumber=${screenNumber}`,
        );
      }

      const textOpt = cur.options?.find((o) => o.name === "text");
      const stringOCR = textOpt?.data?.stringOCR ?? null;
      const sousTitreOCR = textOpt?.data?.sousTitreOCR ?? null;

      return {
        page: {
          view,
          displayable: cur.parameters?.pageIsDisplayable ?? false,
          ocrText: stringOCR ? cleanOcr(stringOCR) || null : null,
          ocrRate: parseOcrRate(sousTitreOCR),
        },
        nbTotalVues: findNbTotalVues(body),
      };
    } catch (err) {
      lastErr = err;
      // A deliberate raise (shape change / folio mismatch / terminal 4xx) is
      // not retried — only transient network errors are.
      if (
        err instanceof Error &&
        (err.message.includes("shape changed") ||
          err.message.includes("folio mismatch") ||
          err.message.includes("HTTP 4"))
      ) {
        throw err;
      }
      if (attempt < retries) {
        await sleep(attempt * 1500);
        continue;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Gallica viewer f${view}: ${String(lastErr)}`);
}

/** nbTotalVues lives somewhere in the viewer payload; a string scan is robust to path drift. */
function findNbTotalVues(body: string): number | null {
  const m = /"nbTotalVues":\s*(\d+)/.exec(body);
  return m ? Number(m[1]) : null;
}

/**
 * Harvest viewer OCR for an ARK. Returns every probed view (displayable or
 * not); the caller keeps the text-bearing ones. Throws on an undeterminable
 * loop bound or a changed viewer shape — never silently returns empty.
 */
export async function fetchViewerOcr(
  ark: string,
  opts: ViewerOcrOptions = {},
): Promise<ViewerOcrResult> {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULTS.concurrency);
  const perRequestTimeoutMs = opts.perRequestTimeoutMs ?? DEFAULTS.perRequestTimeoutMs;
  const wallClockMs = opts.wallClockMs ?? DEFAULTS.wallClockMs;
  const interRequestDelayMs = opts.interRequestDelayMs ?? DEFAULTS.interRequestDelayMs;
  const deadline = Date.now() + wallClockMs;

  // First view does double duty: its response carries nbTotalVues.
  const first = await fetchFolio(ark, 1, perRequestTimeoutMs, DEFAULTS.retries);
  const totalViews = opts.totalViews ?? first.nbTotalVues;
  if (!totalViews || totalViews < 1) {
    throw new Error(
      `Gallica viewer: could not determine totalViews for ${ark} (provide it or ensure nbTotalVues is present).`,
    );
  }

  const limit = Math.min(totalViews, opts.maxViews ?? totalViews);
  const pages: ViewerOcrPage[] = [first.page];

  // Remaining views 2..limit with bounded concurrency.
  const queue: number[] = [];
  for (let n = 2; n <= limit; n++) queue.push(n);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      if (Date.now() > deadline) {
        throw new Error(
          `Gallica viewer harvest exceeded wall-clock ceiling (${wallClockMs}ms) for ${ark}`,
        );
      }
      const view = queue[cursor++]!;
      const r = await fetchFolio(ark, view, perRequestTimeoutMs, DEFAULTS.retries);
      pages.push(r.page);
      if (interRequestDelayMs > 0) await sleep(interRequestDelayMs);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
  );

  pages.sort((a, b) => a.view - b.view);
  return { totalViews, pages };
}

// --- Minimal structural typing for the viewer payload we read ---

interface VRTextData {
  stringOCR?: string | null;
  sousTitreOCR?: string | null;
}
interface VROption {
  name?: string;
  data?: VRTextData;
}
interface VRCurrentPageEntry {
  screenNumber?: number;
  parameters?: { pageIsDisplayable?: boolean };
  options?: VROption[];
}
interface VR {
  fragment?: {
    contenu?: {
      Visualizer?: {
        affichage?: {
          contenu?: {
            renderModel?: {
              contenu?: {
                currentPage?: { contenu?: VRCurrentPageEntry[] };
              };
            };
          };
        };
      };
    };
  };
}
