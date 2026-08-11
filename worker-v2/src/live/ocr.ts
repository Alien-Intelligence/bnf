/**
 * Live OcrEngine — Mistral OCR Batch API, wrapping V1's proven mechanics but
 * SPLIT into submit / poll so the ~25-min batch latency lives off the worker's
 * critical path (the V2 ocr-poll stage re-enqueues a pointer instead of holding
 * a slot). V1's `runMistralOcrBatch` did submit+wait+parse in one blocking call;
 * here:
 *
 *   submitBatch → upload the JSONL + create the batch job → return { batchId }.
 *   pollBatch   → get the job; while non-terminal return { state: "pending" };
 *                 on SUCCESS download + parse the output into folio-aligned
 *                 pages ({ state: "done", pages, dropped, entryErrors, … });
 *                 on ANY OTHER terminal state (FAILED/TIMEOUT_EXCEEDED/
 *                 CANCELLED) return { state: "failed", reason } — even when
 *                 Mistral attached a partial output file (F14,
 *                 ai-memories/tech/repos/bnf/ingest-hardening: a partial
 *                 output on a non-SUCCESS batch must never masquerade as done).
 *
 * Folio alignment is by `custom_id` (`f<ordre>`), never positional — citations
 * depend on it, so the mapping is preserved exactly from V1. Hallucinated pages
 * (Mistral fabricates filler on blank folios) and legitimately blank folios are
 * dropped from `pages` but counted in `dropped` (F14) — never silently
 * absorbed the way V1/the original V2 parse did; per-entry request errors
 * (a line's `error` field, or a non-2xx `response.status_code`) land in
 * `entryErrors`. The caller (stages/ocr-poll.ts) decides what a doc with
 * drops/errors means for that doc.
 *
 * The image bytes arrive as Buffers (already in S3), so we base64 them into the
 * `data:image/jpeg` URL shape the Mistral OCR request wants — mirroring V1.
 */
import { Mistral } from "@mistralai/mistralai";

import { mistralOcr } from "./vendor/env.js";
import { looksLikeHallucinatedOcr } from "./vendor/mistral-ocr.js";
import type { PreparedPage } from "../domain/types.js";
import type { OcrBatchStatus, OcrEngine, OcrEntryError } from "../ports.js";

export { looksLikeHallucinatedOcr };

/** Terminal batch states — poll stops on any of these (mirrors V1). */
const TERMINAL_STATES = new Set([
  "SUCCESS",
  "FAILED",
  "TIMEOUT_EXCEEDED",
  "CANCELLED",
]);

/** Shape of one line in the downloaded batch output JSONL. Parsed defensively. */
export interface MistralBatchOutputLine {
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

/** `f<ordre>` → ordre. Returns null for anything that isn't our custom_id shape. */
function parseOrdre(customId: string | undefined): number | null {
  if (!customId) return null;
  const m = /^f(\d+)$/.exec(customId);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/** The honest result of parsing a batch's output JSONL (F14) — nothing is
 *  silently discarded; every dropped/errored entry is counted. */
export interface OcrParseResult {
  pages: PreparedPage[];
  dropped: { empty: number; hallucinated: number };
  entryErrors: OcrEntryError[];
}

/**
 * Pure: parse the downloaded batch output JSONL into folio-aligned pages,
 * HONESTLY (F14) — every entry that doesn't become a page is counted, not
 * silently dropped:
 *
 * - Each line is one JSON object; a malformed line (bad JSON, or a custom_id
 *   that doesn't parse to an ordre) is skipped but recorded in `entryErrors`
 *   with `ordre: null` (its folio can't be known).
 * - `custom_id` maps back to the folio `ordre` (NOT positional — a batch may
 *   reorder entries; citations depend on the custom_id mapping).
 * - A per-line `error` field or a non-2xx `response.status_code` means the
 *   REQUEST failed for that folio — recorded in `entryErrors`, no page.
 * - Empty markdown is counted in `dropped.empty` (a legitimately blank folio).
 * - Hallucinated pages (blank-folio filler, via the V1 detector) are counted
 *   in `dropped.hallucinated`.
 * - Output pages are sorted ascending by ordre.
 *
 * Exported so the alignment + the honesty accounting can be unit-tested with
 * a fixture, no SDK/HTTP.
 */
export function parseOcrOutput(jsonl: string): OcrParseResult {
  const pages: PreparedPage[] = [];
  const entryErrors: OcrEntryError[] = [];
  let droppedEmpty = 0;
  let droppedHallucinated = 0;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: MistralBatchOutputLine;
    try {
      entry = JSON.parse(trimmed) as MistralBatchOutputLine;
    } catch {
      entryErrors.push({ ordre: null, error: "malformed_output_line: invalid JSON" });
      continue;
    }
    const ordre = parseOrdre(entry.custom_id);
    if (ordre === null) {
      entryErrors.push({
        ordre: null,
        error: `malformed_output_line: unrecognized custom_id "${entry.custom_id ?? ""}"`,
      });
      continue;
    }
    if (entry.error) {
      entryErrors.push({ ordre, error: `request_error: ${JSON.stringify(entry.error)}` });
      continue;
    }
    const statusCode = entry.response?.status_code;
    if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) {
      entryErrors.push({ ordre, error: `http_${statusCode}` });
      continue;
    }
    const markdown = entry.response?.body?.pages?.[0]?.markdown;
    if (typeof markdown !== "string" || markdown.trim().length === 0) {
      droppedEmpty++;
      continue;
    }
    if (looksLikeHallucinatedOcr(markdown)) {
      droppedHallucinated++;
      continue;
    }
    pages.push({ ordre, text: markdown });
  }
  pages.sort((a, b) => a.ordre - b.ordre);
  return { pages, dropped: { empty: droppedEmpty, hallucinated: droppedHallucinated }, entryErrors };
}

/**
 * Safe ceiling on the assembled batch-input size (bytes). Buffers can hold ~2GiB,
 * but we fail well before that with a CLEAR, attributable error rather than risk an
 * allocation crash — a doc this large is better split or skipped than OOMing the
 * worker. ~1.5GiB of base64 ≈ many hundreds of full-res folios.
 */
const MAX_BATCH_INPUT_BYTES = 1_500 * 1_024 * 1_024;

/**
 * Assemble the Mistral Batch input JSONL as a Buffer (one line per folio).
 *
 * Built line-by-line into a Buffer — never one joined JS string — so a doc with
 * many full-res base64 images can't trip V8's ~512MB max string length (the live
 * `Invalid string length` crash on the OCR-submit stage). Throws a clear,
 * doc-attributable error if the total would exceed MAX_BATCH_INPUT_BYTES (the stage
 * turns that into a clean doc-fail instead of a cryptic allocation failure).
 *
 * Exported for unit testing — pure, deterministic, no SDK/HTTP.
 */
export function buildBatchJsonl(
  ark: string,
  folios: Array<{ ordre: number; image: Buffer }>,
): Buffer {
  const newline = Buffer.from("\n", "utf8");
  const chunks: Buffer[] = [];
  let total = 0;
  for (const f of folios) {
    const line = JSON.stringify({
      custom_id: `f${f.ordre}`,
      body: {
        document: {
          type: "image_url",
          image_url: `data:image/jpeg;base64,${f.image.toString("base64")}`,
        },
        include_image_base64: false,
      },
    });
    const lineBuf = Buffer.from(line, "utf8");
    total += lineBuf.length + newline.length;
    if (total > MAX_BATCH_INPUT_BYTES) {
      throw new Error(
        `ocr submitBatch: ${ark} batch input exceeds ${MAX_BATCH_INPUT_BYTES} bytes ` +
          `at folio ${f.ordre} (${folios.length} folios) — doc too large for a single batch`,
      );
    }
    chunks.push(lineBuf, newline);
  }
  return Buffer.concat(chunks);
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
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

export class LiveOcrEngine implements OcrEngine {
  /**
   * Optional injected SDK client — the same pattern as LiveEmbedder's injected
   * `RunpodBgeM3` (embedder.ts): tests build a minimal stub cast `as unknown as
   * Mistral` (see ocr.test.ts) so `pollBatch`'s honesty classification (F14) is
   * unit-testable without touching the network. Production passes none, so the
   * module-level `client()` lazy singleton is untouched — non-OCR runs still
   * never construct a Mistral client and never need MISTRAL_API_KEY.
   */
  constructor(private readonly injected?: Mistral) {}

  private mistralClient(): Mistral {
    return this.injected ?? client();
  }

  async submitBatch(input: {
    ark: string;
    folios: Array<{ ordre: number; image: Buffer }>;
  }): Promise<{ batchId: string }> {
    if (input.folios.length === 0) {
      throw new Error(`ocr submitBatch: no folios for ${input.ark}`);
    }
    const mistral = this.mistralClient();

    // 1. Build the JSONL — one OCR request per folio. custom_id carries the
    //    folio ordre so the result maps back regardless of batch ordering.
    //
    //    Assembled as a Buffer, NOT a single joined string. Mistral OCR keeps
    //    full-res images, so each folio's base64 data-URL is multi-MB; a doc with
    //    hundreds of folios overflows V8's ~512MB max STRING length on
    //    `.map().join("\n")` (the live `Invalid string length` crash). A Buffer has
    //    no such ceiling, so we encode each line independently and concat.
    const content = buildBatchJsonl(input.ark, input.folios);

    // 2. Upload as a batch input file.
    const inputFile = await mistral.files.upload({
      file: { fileName: "bnf-ocr-batch.jsonl", content },
      purpose: "batch",
    });

    // 3. Create the batch job against the OCR endpoint and return — do NOT wait.
    const timeoutHours = Math.max(1, Math.ceil(mistralOcr.batchTimeoutMs() / 3_600_000));
    const job = await mistral.batch.jobs.create({
      inputFiles: [inputFile.id],
      endpoint: "/v1/ocr",
      model: mistralOcr.model(),
      timeoutHours,
    });
    return { batchId: job.id };
  }

  async pollBatch(batchId: string): Promise<OcrBatchStatus> {
    const mistral = this.mistralClient();
    const job = await mistral.batch.jobs.get({ jobId: batchId });

    if (!TERMINAL_STATES.has(String(job.status))) {
      return { state: "pending" };
    }

    // Honest terminal classification (F14): a batch that ended anything OTHER
    // than SUCCESS is ALWAYS "failed" — even when Mistral attached a partial
    // outputFile. A TIMEOUT_EXCEEDED/FAILED/CANCELLED batch's output must never
    // masquerade as done; the caller (ocr-poll) un-poisons the batch handle
    // (F15) on this path so a re-ingest resubmits fresh instead of re-polling
    // this same dead batch forever.
    if (job.status !== "SUCCESS") {
      return {
        state: "failed",
        reason:
          `Mistral batch ${batchId} ended ${job.status} ` +
          `(${job.succeededRequests}/${job.totalRequests} succeeded, ` +
          `${job.failedRequests} failed)`,
      };
    }

    if (!job.outputFile) {
      return {
        state: "failed",
        reason: `Mistral batch ${batchId} SUCCESS but no output file`,
      };
    }

    const text = await streamToString(await mistral.files.download({ fileId: job.outputFile }));
    if (process.env.MISTRAL_OCR_DEBUG === "1") {
      console.log(`[mistral-ocr] raw output (${text.length} chars):\n${text.slice(0, 3000)}`);
    }
    const { pages, dropped, entryErrors } = parseOcrOutput(text);
    return {
      state: "done",
      pages,
      dropped,
      entryErrors,
      succeeded: job.succeededRequests,
      failed: job.failedRequests,
    };
  }
}
