/**
 * Mistral OCR — Batch API mechanics, isolated from BnF knowledge.
 *
 * Used by extract.ts to transcribe `sans_texte` documents (digitized text with
 * no BnF OCR layer). One batch job per document: a JSONL with one entry per
 * folio image (base64 data-URL), submitted to the `/v1/ocr` endpoint at the
 * Batch rate ($2/1000 pages). `custom_id` carries the folio number so the
 * result maps back to the right page even if the batch reorders entries —
 * folio alignment is by construction, never positional (citations depend on it).
 *
 * This module knows nothing about ARKs, IIIF, or rendering. The caller hands it
 * `{ ordre, dataUrl }` folios and gets `{ ordre, markdown }` pages back.
 */
import { Mistral } from "@mistralai/mistralai";

import { mistralOcr } from "./env.js";

/** One folio image to transcribe — `dataUrl` is a base64 `data:image/…` URL. */
export interface MistralOcrFolio {
  ordre: number;
  dataUrl: string;
}

/** Markdown transcription for one folio. */
export interface MistralOcrPageResult {
  ordre: number;
  markdown: string;
}

export interface MistralOcrBatchResult {
  pages: MistralOcrPageResult[];
  /** Per-request counters reported by the batch job (for logging / cost). */
  succeeded: number;
  failed: number;
}

/** Terminal batch states — the poll loop stops on any of these. */
const TERMINAL_STATES = new Set([
  "SUCCESS",
  "FAILED",
  "TIMEOUT_EXCEEDED",
  "CANCELLED",
]);

/** Shape of one line in the downloaded batch output JSONL. Parsed defensively. */
interface MistralBatchOutputLine {
  custom_id?: string;
  response?: {
    status_code?: number;
    body?: { pages?: Array<{ index?: number; markdown?: string }> };
  };
  error?: unknown;
}

let cachedClient: Mistral | null = null;

/** Lazily built so non-OCR runs never need MISTRAL_API_KEY. */
function client(): Mistral {
  if (!cachedClient) cachedClient = new Mistral({ apiKey: mistralOcr.apiKey() });
  return cachedClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect a hallucinated OCR page — Mistral fabricates content on blank/near-blank
 * folios instead of returning empty: it repeats one filler line dozens of times
 * (e.g. "The following table is a simple diagram and cannot be extracted.") and
 * injects unrelated text (CJK boilerplate, leaked instructions). Per-page
 * confidence does NOT flag these (the model is confidently wrong — verified: a
 * garbage page scored avg 0.968 vs 0.936 for a clean one), so we key on the two
 * structural tells instead:
 *
 *   1. The SAME long line (≥12 chars) repeated ≥4×. Genuine prose never repeats
 *      a full sentence that many times; counting absolute repeats (not a ratio)
 *      avoids false-positiving a real page that is one long, unbroken paragraph.
 *   2. ≥2 lines matching the blank-region filler / instruction-leak markers.
 *
 * A flagged page is dropped (treated as a blank folio — no citation, which is
 * correct) rather than indexed, so fabricated text never reaches the RAG store.
 */
const HALLUCINATION_FILLER_RE =
  /cannot be extracted|simple (?:diagram|formula)|ground truth|underscore.{0,24}rule/i;

export function looksLikeHallucinatedOcr(markdown: string): boolean {
  const lines = markdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);
  if (lines.length === 0) return false;

  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const maxRepeat = Math.max(...counts.values());
  if (maxRepeat >= 4) return true;

  const fillerLines = lines.filter((l) => HALLUCINATION_FILLER_RE.test(l)).length;
  return fillerLines >= 2;
}

/** `f<ordre>` → ordre. Returns null for anything that isn't our custom_id shape. */
function parseOrdre(customId: string | undefined): number | null {
  if (!customId) return null;
  const m = /^f(\d+)$/.exec(customId);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/**
 * Transcribe a set of folio images via one Mistral OCR batch job.
 *
 * Blocks until the job reaches a terminal state, bounded by
 * MISTRAL_OCR_BATCH_TIMEOUT_MS (throws on timeout so the doc-job retries rather
 * than wedging). A batch that ends non-SUCCESS with no output throws; a batch
 * that partially succeeds returns the folios it got (the caller decides whether
 * that is enough). Returns pages ordered by folio.
 */
export async function runMistralOcrBatch(
  folios: MistralOcrFolio[],
): Promise<MistralOcrBatchResult> {
  if (folios.length === 0) return { pages: [], succeeded: 0, failed: 0 };
  const mistral = client();

  // 1. Build the JSONL — one OCR request per folio. The model is set at the job
  //    level; each line carries only the document and its folio custom_id.
  const jsonl =
    folios
      .map((f) =>
        JSON.stringify({
          custom_id: `f${f.ordre}`,
          body: {
            document: { type: "image_url", image_url: f.dataUrl },
            include_image_base64: false,
          },
        }),
      )
      .join("\n") + "\n";

  // 2. Upload it as a batch input file.
  const inputFile = await mistral.files.upload({
    file: {
      fileName: "bnf-ocr-batch.jsonl",
      content: new TextEncoder().encode(jsonl),
    },
    purpose: "batch",
  });

  // 3. Create the batch job against the OCR endpoint.
  const timeoutHours = Math.max(
    1,
    Math.ceil(mistralOcr.batchTimeoutMs() / 3_600_000),
  );
  let job = await mistral.batch.jobs.create({
    inputFiles: [inputFile.id],
    endpoint: "/v1/ocr",
    model: mistralOcr.model(),
    timeoutHours,
  });

  // 4. Poll to a terminal state, bounded by the wall-clock ceiling.
  const deadline = Date.now() + mistralOcr.batchTimeoutMs();
  while (!TERMINAL_STATES.has(String(job.status))) {
    if (Date.now() > deadline) {
      throw new Error(
        `Mistral batch ${job.id} timed out after ${mistralOcr.batchTimeoutMs()}ms (status ${job.status})`,
      );
    }
    await sleep(mistralOcr.pollIntervalMs());
    job = await mistral.batch.jobs.get({ jobId: job.id });
  }

  if (job.status !== "SUCCESS" && !job.outputFile) {
    throw new Error(
      `Mistral batch ${job.id} ended ${job.status} with no output ` +
        `(${job.succeededRequests}/${job.totalRequests} succeeded)`,
    );
  }

  // 5. Download + parse the output JSONL, mapping each custom_id back to a folio.
  const pages: MistralOcrPageResult[] = [];
  if (job.outputFile) {
    const text = await streamToString(
      await mistral.files.download({ fileId: job.outputFile }),
    );
    if (process.env.MISTRAL_OCR_DEBUG === "1") {
      console.log(
        `[mistral-ocr] raw output (${text.length} chars):\n${text.slice(0, 3000)}`,
      );
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: MistralBatchOutputLine;
      try {
        entry = JSON.parse(trimmed) as MistralBatchOutputLine;
      } catch {
        continue;
      }
      const ordre = parseOrdre(entry.custom_id);
      if (ordre === null) continue;
      const markdown = entry.response?.body?.pages?.[0]?.markdown;
      if (typeof markdown === "string" && markdown.trim().length > 0) {
        pages.push({ ordre, markdown });
      }
    }
  }

  pages.sort((a, b) => a.ordre - b.ordre);
  return {
    pages,
    succeeded: job.succeededRequests,
    failed: job.failedRequests,
  };
}
