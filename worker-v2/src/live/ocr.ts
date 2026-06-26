/**
 * Live OcrEngine — Mistral OCR Batch API, wrapping V1's proven mechanics but
 * SPLIT into submit / poll so the ~25-min batch latency lives off the worker's
 * critical path (the V2 ocr-poll stage re-enqueues a pointer instead of holding
 * a slot). V1's `runMistralOcrBatch` did submit+wait+parse in one blocking call;
 * here:
 *
 *   submitBatch → upload the JSONL + create the batch job → return { batchId }.
 *   pollBatch   → get the job; while non-terminal return { state: "pending" };
 *                 on SUCCESS download + parse the output into folio-aligned pages
 *                 ({ state: "done" }); on a failed terminal state with no output
 *                 return { state: "failed", reason }.
 *
 * Folio alignment is by `custom_id` (`f<ordre>`), never positional — citations
 * depend on it, so the mapping is preserved exactly from V1. Hallucinated pages
 * (Mistral fabricates filler on blank folios) are dropped via V1's
 * `looksLikeHallucinatedOcr`; a dropped page is simply omitted.
 *
 * The image bytes arrive as Buffers (already in S3), so we base64 them into the
 * `data:image/jpeg` URL shape the Mistral OCR request wants — mirroring V1.
 */
import { Mistral } from "@mistralai/mistralai";

import { mistralOcr } from "./vendor/env.js";
import { looksLikeHallucinatedOcr } from "./vendor/mistral-ocr.js";
import type { PreparedPage } from "../domain/types.js";
import type { OcrBatchStatus, OcrEngine } from "../ports.js";

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

/**
 * Pure: parse the downloaded batch output JSONL into folio-aligned pages.
 *
 * - Each line is one JSON object; malformed lines are skipped.
 * - `custom_id` maps back to the folio `ordre` (NOT positional — a batch may
 *   reorder entries; citations depend on the custom_id mapping).
 * - Empty markdown is dropped (a legitimately blank folio = no page).
 * - Hallucinated pages (blank-folio filler) are dropped via the V1 detector.
 * - Output is sorted ascending by ordre.
 *
 * Exported so the alignment can be unit-tested with a fixture, no SDK/HTTP.
 */
export function parseOcrOutput(jsonl: string): PreparedPage[] {
  const pages: PreparedPage[] = [];
  for (const line of jsonl.split("\n")) {
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
    if (typeof markdown !== "string" || markdown.trim().length === 0) continue;
    if (looksLikeHallucinatedOcr(markdown)) continue;
    pages.push({ ordre, text: markdown });
  }
  pages.sort((a, b) => a.ordre - b.ordre);
  return pages;
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
  async submitBatch(input: {
    ark: string;
    folios: Array<{ ordre: number; image: Buffer }>;
  }): Promise<{ batchId: string }> {
    if (input.folios.length === 0) {
      throw new Error(`ocr submitBatch: no folios for ${input.ark}`);
    }
    const mistral = client();

    // 1. Build the JSONL — one OCR request per folio. custom_id carries the
    //    folio ordre so the result maps back regardless of batch ordering.
    const jsonl =
      input.folios
        .map((f) =>
          JSON.stringify({
            custom_id: `f${f.ordre}`,
            body: {
              document: {
                type: "image_url",
                image_url: `data:image/jpeg;base64,${f.image.toString("base64")}`,
              },
              include_image_base64: false,
            },
          }),
        )
        .join("\n") + "\n";

    // 2. Upload as a batch input file.
    const inputFile = await mistral.files.upload({
      file: {
        fileName: "bnf-ocr-batch.jsonl",
        content: new TextEncoder().encode(jsonl),
      },
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
    const mistral = client();
    const job = await mistral.batch.jobs.get({ jobId: batchId });

    if (!TERMINAL_STATES.has(String(job.status))) {
      return { state: "pending" };
    }

    if (job.status !== "SUCCESS" && !job.outputFile) {
      return {
        state: "failed",
        reason:
          `Mistral batch ${batchId} ended ${job.status} with no output ` +
          `(${job.succeededRequests}/${job.totalRequests} succeeded)`,
      };
    }

    if (!job.outputFile) {
      return {
        state: "failed",
        reason: `Mistral batch ${batchId} ${job.status} but no output file`,
      };
    }

    const text = await streamToString(await mistral.files.download({ fileId: job.outputFile }));
    if (process.env.MISTRAL_OCR_DEBUG === "1") {
      console.log(`[mistral-ocr] raw output (${text.length} chars):\n${text.slice(0, 3000)}`);
    }
    const pages = parseOcrOutput(text);
    return { state: "done", pages };
  }
}
