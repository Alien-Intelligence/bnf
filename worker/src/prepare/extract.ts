/**
 * Branching extraction step.
 *
 * Given a `BnfDocInfo`, decide one of three outcomes:
 *
 *   1. `text_with_ocr` — info.ocrAvailable === true. Fetch the OCR text and
 *      return the page array.
 *   2. `single_image`  — no OCR, but docType is one of the single-visual types.
 *      Derive the IIIF image URL per canvas, then describe each with Holo2
 *      (see `./vision.ts`) — return the descriptions + iiif urls.
 *   3. `skip`          — neither path applies, return the skip reason.
 */
import { mistralOcr } from "../env.js";
import type { BnfDocInfo, SkipReason } from "../types.js";
import type { BnfApi } from "./bnf-api.js";
import { PermanentBnfError } from "./errors.js";
import { runMistralOcrBatch, type MistralOcrFolio } from "./mistral-ocr.js";
import type { OcrPage } from "./render.js";
import { describeImage, fetchImage, type ImageDescription } from "./vision.js";

/** IIIF size for OCR folio fetches — larger than the vision path (1280) so dense
 *  historical type stays legible to the OCR model. `!w,h` returns a best fit. */
const MISTRAL_OCR_IIIF_SIZE = "!2000,2000";

/**
 * Substring patterns matched (case-insensitive) against `doc_type` to decide
 * whether a doc is visual-only and goes through the Holo path.
 *
 * BnF vocabulary is inconsistent across endpoints — search returns short codes
 * ("image", "carte"), document-info returns descriptive strings
 * ("image fixe", "carte ancienne"). Substring matching handles both.
 */
const IMAGE_DOC_TYPE_PATTERNS = [
  "image",
  "carte",
  "estampe",
  "photograph",
  "partition",
  "affiche",
  "manuscrit",
  "dessin",
  "iconograph",
];

function isImageDocType(docType: string | null): boolean {
  if (!docType) return false;
  const dt = docType.toLowerCase();
  return IMAGE_DOC_TYPE_PATTERNS.some((p) => dt.includes(p));
}

/** One described canvas of a (possibly multi-canvas) image document. */
export interface ImagePage {
  /** Canvas `ordre` from the IIIF manifest (1-based, matches BnF f<ordre> URLs). */
  ordre: number;
  /** Optional canvas label from the manifest. */
  label: string | null;
  /** Direct IIIF image URL for this canvas (used as citation link). */
  iiifUrl: string;
  /** Holo2 description for this canvas. */
  description: ImageDescription;
}

export type ExtractResult =
  | { kind: "text_with_ocr"; pages: OcrPage[] }
  | { kind: "image_pages"; pages: ImagePage[]; totalCanvases: number; cappedAt: number | null }
  // Same OcrPage[] shape as `text_with_ocr` (renders + chunks identically), but
  // the text came from paid Mistral OCR — index.ts stamps the provenance.
  | { kind: "mistral_ocr"; pages: OcrPage[]; totalCanvases: number; cappedAt: number | null }
  | { kind: "skip"; reason: SkipReason };

export interface ExtractOpts {
  /** Max pages to fetch via getDocumentText. Default 200. */
  maxOcrPages?: number;
  /** Max canvases to describe on the image path. Default 200. */
  maxImageCanvases?: number;
  /** Concurrent Holo calls. Default 3 (Scaleway rate-limit-friendly). */
  imageConcurrency?: number;
}

export async function extract(
  bnf: BnfApi,
  info: BnfDocInfo,
  opts: ExtractOpts = {},
): Promise<ExtractResult> {
  if (info.ocrAvailable) {
    return extractOcr(bnf, info, opts);
  }
  if (isImageDocType(info.docType)) {
    return extractImagePages(bnf, info, opts);
  }
  // Digitized text with no OCR layer and not an image type (`sans_texte`). When
  // paid fallback OCR is enabled, transcribe it via Mistral instead of skipping.
  // The app only sends such docs once the spend is confirmed (see the ingest
  // confirmation handshake), so reaching here means we are cleared to pay.
  if (mistralOcr.enabled()) {
    return extractMistralOcr(bnf, info, opts);
  }
  return {
    kind: "skip",
    reason: {
      skip: true,
      reason: "no_ocr_and_not_single_image",
      arkInfo: info,
    },
  };
}

/**
 * Paid fallback OCR path. Fetch the IIIF manifest, pull each folio image through
 * the same broker/relay/rate-limit path the vision path uses, base64 them, and
 * run one Mistral OCR batch over the lot. Returns `text_with_ocr`-shaped pages
 * (one per transcribed folio) so render/chunk/index are unchanged.
 */
async function extractMistralOcr(
  bnf: BnfApi,
  info: BnfDocInfo,
  opts: ExtractOpts,
): Promise<ExtractResult> {
  const maxCanvases = mistralOcr.maxPages();
  const concurrency = Math.max(1, opts.imageConcurrency ?? 4);

  // 1. Manifest → canvas list (same permanent/transient split as the image path).
  let manifest;
  try {
    manifest = await bnf.getManifest(info.ark, { maxCanvases });
  } catch (e) {
    if (e instanceof PermanentBnfError) {
      return {
        kind: "skip",
        reason: {
          skip: true,
          reason: "metadata_unavailable",
          ark: info.ark,
          cause: `getManifest permanent: ${e.cause}`,
        },
      };
    }
    throw e;
  }
  if (manifest.canvases.length === 0) {
    return {
      kind: "skip",
      reason: {
        skip: true,
        reason: "metadata_unavailable",
        ark: info.ark,
        cause: "getManifest returned no canvases",
      },
    };
  }
  const cappedAt = manifest.totalPages > maxCanvases ? maxCanvases : null;

  // 2. Fetch each folio image as a base64 data-URL (politeness path reused from
  //    vision.fetchImage). A folio whose image can't be fetched is dropped, not
  //    fatal — the batch still runs over the folios we did get.
  const fetchFolio = async (
    canvas: typeof manifest.canvases[number],
  ): Promise<MistralOcrFolio | null> => {
    let url: string;
    try {
      url = await bnf.getImageUrl(info.ark, {
        ordre: canvas.ordre,
        size: MISTRAL_OCR_IIIF_SIZE,
      });
    } catch (e) {
      console.warn(
        `[extract] mistral: skipping canvas ordre=${canvas.ordre} of ${info.ark}: getImageUrl failed (${errorMessage(e)})`,
      );
      return null;
    }
    try {
      const img = await fetchImage(url);
      return { ordre: canvas.ordre, dataUrl: img.dataUrl };
    } catch (e) {
      console.warn(
        `[extract] mistral: skipping canvas ordre=${canvas.ordre} of ${info.ark}: image fetch failed (${errorMessage(e)})`,
      );
      return null;
    }
  };

  const fetched = (
    await runWithConcurrency(manifest.canvases, concurrency, fetchFolio)
  ).filter((f): f is MistralOcrFolio => f !== null);

  if (fetched.length === 0) {
    return {
      kind: "skip",
      reason: {
        skip: true,
        reason: "ocr_fetch_failed",
        ark: info.ark,
        cause: "could not fetch any folio image for Mistral OCR",
      },
    };
  }

  // 3. One batch over all fetched folios. Transient/timeout errors propagate so
  //    pg-boss retries the whole doc-job; permanent failures surface as a skip.
  const batch = await runMistralOcrBatch(fetched);
  const pages: OcrPage[] = batch.pages.map((p) => ({
    ordre: p.ordre,
    text: p.markdown,
  }));

  if (pages.length === 0) {
    return {
      kind: "skip",
      reason: {
        skip: true,
        reason: "ocr_fetch_failed",
        ark: info.ark,
        cause: `Mistral OCR returned no text (${batch.failed} folio(s) failed)`,
      },
    };
  }

  // Batch rate is $2/1000 pages — log the rough spend for observability.
  const estUsd = (pages.length / 1000) * 2;
  console.log(
    `[extract] mistral OCR ${info.ark}: ${pages.length}/${fetched.length} folios transcribed (~$${estUsd.toFixed(2)})`,
  );

  return {
    kind: "mistral_ocr",
    pages,
    totalCanvases: manifest.totalPages,
    cappedAt,
  };
}

async function extractOcr(
  bnf: BnfApi,
  info: BnfDocInfo,
  opts: ExtractOpts,
): Promise<ExtractResult> {
  try {
    const raw = await bnf.getDocumentText(info.ark, {
      maxPages: opts.maxOcrPages ?? 200,
      // Page count from metadata (OAI "Nombre total de vues") lets the partner
      // OCR path iterate folios without a manifest call (off the 12/min cap).
      pageCount: info.pageCount,
    });

    // Prefer the structured `pages` array (preserves per-page boundaries we
    // turn into `## Folio N` headings). Fall back to the flat `text` field
    // with a single synthetic page when the source only returns combined text.
    const pages: OcrPage[] = [];
    if (Array.isArray(raw.pages)) {
      for (const p of raw.pages) {
        if (typeof p.text !== "string" || p.text.trim().length === 0) continue;
        const ordre = typeof p.ordre === "number" ? p.ordre : pages.length + 1;
        pages.push({ ordre, text: p.text });
      }
    }
    if (pages.length === 0 && typeof raw.text === "string" && raw.text.trim().length > 0) {
      pages.push({ ordre: 1, text: raw.text });
    }

    if (pages.length === 0) {
      return {
        kind: "skip",
        reason: {
          skip: true,
          reason: "ocr_fetch_failed",
          ark: info.ark,
          cause: "getDocumentText returned no text",
        },
      };
    }
    return { kind: "text_with_ocr", pages };
  } catch (e) {
    // Permanent errors become a typed skip — the document is structurally
    // unfetchable. Transient errors propagate so pg-boss retries the whole
    // doc-job.
    if (e instanceof PermanentBnfError) {
      return {
        kind: "skip",
        reason: {
          skip: true,
          reason: "ocr_fetch_failed",
          ark: info.ark,
          cause: `permanent: ${e.cause}`,
        },
      };
    }
    throw e;
  }
}

async function extractImagePages(
  bnf: BnfApi,
  info: BnfDocInfo,
  opts: ExtractOpts,
): Promise<ExtractResult> {
  const maxCanvases = opts.maxImageCanvases ?? 200;
  const concurrency = Math.max(1, opts.imageConcurrency ?? 3);

  // 1. Fetch manifest to learn the canvas list.
  let manifest;
  try {
    manifest = await bnf.getManifest(info.ark, { maxCanvases });
  } catch (e) {
    if (e instanceof PermanentBnfError) {
      return {
        kind: "skip",
        reason: {
          skip: true,
          reason: "metadata_unavailable",
          ark: info.ark,
          cause: `getManifest permanent: ${e.cause}`,
        },
      };
    }
    throw e;
  }

  if (manifest.canvases.length === 0) {
    return {
      kind: "skip",
      reason: {
        skip: true,
        reason: "metadata_unavailable",
        ark: info.ark,
        cause: "getManifest returned no canvases",
      },
    };
  }

  const cappedAt = manifest.totalPages > maxCanvases ? maxCanvases : null;

  // 2. For each canvas, derive the image URL + describe with Holo2.
  //    Bounded concurrency — Scaleway can handle a few in parallel, but we
  //    don't want to blast it on a 50-canvas album.
  const describePage = async (
    canvas: typeof manifest.canvases[number],
  ): Promise<ImagePage | null> => {
    let iiifUrl: string;
    try {
      iiifUrl = await bnf.getImageUrl(info.ark, {
        ordre: canvas.ordre,
        size: "!1280,1280",
      });
    } catch (e) {
      console.warn(
        `[extract] skipping canvas ordre=${canvas.ordre} of ${info.ark}: getImageUrl failed (${errorMessage(e)})`,
      );
      return null;
    }
    try {
      // Up to two Holo attempts: if the first comes back with unparseable
      // JSON, give it a second try before giving up. (Network errors are
      // already retried inside the OpenAI SDK; we only retry the
      // parse-failure case here.)
      const context = {
        ark: info.ark,
        title: info.title ?? undefined,
        creator: info.creator ?? undefined,
        date: info.date ?? undefined,
        docType: info.docType ?? undefined,
      };
      let result = await describeImage(iiifUrl, { context });
      if (!result.parsed) {
        console.warn(
          `[extract] canvas ordre=${canvas.ordre} of ${info.ark}: Holo2 unparseable on attempt 1 (raw len=${result.raw.length}), retrying once`,
        );
        result = await describeImage(iiifUrl, { context });
      }
      if (!result.parsed) {
        console.warn(
          `[extract] skipping canvas ordre=${canvas.ordre} of ${info.ark}: Holo2 unparseable after retry (raw len=${result.raw.length})`,
        );
        return null;
      }
      return {
        ordre: canvas.ordre,
        label: canvas.label,
        iiifUrl,
        description: result.parsed,
      };
    } catch (e) {
      console.warn(
        `[extract] skipping canvas ordre=${canvas.ordre} of ${info.ark}: Holo2 threw (${errorMessage(e)})`,
      );
      return null;
    }
  };

  const pages = await runWithConcurrency(manifest.canvases, concurrency, describePage);
  const successful = pages.filter((p): p is ImagePage => p !== null);

  if (successful.length === 0) {
    return {
      kind: "skip",
      reason: {
        skip: true,
        reason: "holo_failed",
        ark: info.ark,
        cause: "all canvases failed Holo description",
      },
    };
  }

  return {
    kind: "image_pages",
    pages: successful,
    totalCanvases: manifest.totalPages,
    cappedAt,
  };
}

/** Bounded-concurrency map preserving input order. */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
