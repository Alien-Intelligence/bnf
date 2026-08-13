/**
 * Pure-logic tests for the live OCR result parsing, plus `LiveOcrEngine.
 * pollBatch`'s terminal-state honesty classification (F14).
 *
 * parseOcrOutput/looksLikeHallucinatedOcr/buildBatchJsonl are citation-critical
 * (custom_id↔ordre alignment — results may arrive in any order, must realign,
 * never positionally) and are exercised with no SDK, no network. pollBatch
 * needs the Mistral SDK's `batch.jobs.get`/`files.download` shape, so those
 * tests inject a minimal stub cast `as unknown as Mistral` — the same pattern
 * LiveEmbedder's tests use for its injected RunPod adapter (embedder.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Mistral } from "@mistralai/mistralai";

import { buildBatchJsonl, LiveOcrEngine, looksLikeHallucinatedOcr, parseOcrOutput } from "./ocr.js";

function line(customId: string, markdown: string): string {
  return JSON.stringify({
    custom_id: customId,
    response: { status_code: 200, body: { pages: [{ index: 0, markdown }] } },
  });
}

/** A ReadableStream<Uint8Array> yielding `text` in one chunk — what
 *  `mistral.files.download` returns, per streamToString's consumption. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Minimal stub typed as Mistral — only batch.jobs.get + files.download are
 *  reached by pollBatch. */
function stubMistral(
  job: {
    status: string;
    outputFile?: string | null;
    succeededRequests: number;
    failedRequests: number;
    totalRequests: number;
  },
  outputJsonl = "",
): Mistral {
  return {
    batch: { jobs: { get: async () => job } },
    files: { download: async () => streamOf(outputJsonl) },
  } as unknown as Mistral;
}

test("parseOcrOutput realigns by custom_id and sorts by ordre (not positional)", () => {
  // Deliberately out of order: f3 then f1 then f2.
  const jsonl = [
    line("f3", "Texte du folio 3"),
    line("f1", "Texte du folio 1"),
    line("f2", "Texte du folio 2"),
  ].join("\n");
  const result = parseOcrOutput(jsonl);
  assert.deepEqual(result.pages, [
    { ordre: 1, text: "Texte du folio 1" },
    { ordre: 2, text: "Texte du folio 2" },
    { ordre: 3, text: "Texte du folio 3" },
  ]);
  assert.deepEqual(result.dropped, { empty: 0, hallucinated: 0 });
  assert.deepEqual(result.entryErrors, []);
});

test("parseOcrOutput counts empty/whitespace markdown as dropped.empty (legitimately blank folio)", () => {
  const jsonl = [line("f1", "Réel"), line("f2", "   "), line("f3", "")].join("\n");
  const result = parseOcrOutput(jsonl);
  assert.deepEqual(result.pages, [{ ordre: 1, text: "Réel" }]);
  assert.deepEqual(result.dropped, { empty: 2, hallucinated: 0 });
  assert.deepEqual(result.entryErrors, []);
});

test("parseOcrOutput skips malformed lines and bad custom_ids, but counts them as entryErrors", () => {
  const jsonl = [
    line("f1", "ok"),
    "not json at all",
    JSON.stringify({ custom_id: "garbage", response: { body: { pages: [{ markdown: "x" }] } } }),
    "",
  ].join("\n");
  const result = parseOcrOutput(jsonl);
  assert.deepEqual(result.pages, [{ ordre: 1, text: "ok" }]);
  assert.equal(result.entryErrors.length, 2, "one invalid-JSON line + one bad custom_id, both counted");
  assert.ok(result.entryErrors.every((e) => e.ordre === null));
  assert.match(result.entryErrors[0]?.error ?? "", /malformed_output_line/);
  assert.match(result.entryErrors[1]?.error ?? "", /malformed_output_line/);
});

test("parseOcrOutput counts a per-line `error` field as an entryError, no page", () => {
  const jsonl = [
    line("f1", "ok"),
    JSON.stringify({ custom_id: "f2", error: { message: "rate limited" } }),
  ].join("\n");
  const result = parseOcrOutput(jsonl);
  assert.deepEqual(result.pages, [{ ordre: 1, text: "ok" }]);
  assert.equal(result.entryErrors.length, 1);
  assert.equal(result.entryErrors[0]?.ordre, 2);
  assert.match(result.entryErrors[0]?.error ?? "", /request_error/);
});

test("parseOcrOutput counts a non-2xx response.status_code as an entryError, no page", () => {
  const jsonl = [
    line("f1", "ok"),
    JSON.stringify({ custom_id: "f2", response: { status_code: 500, body: { pages: [] } } }),
  ].join("\n");
  const result = parseOcrOutput(jsonl);
  assert.deepEqual(result.pages, [{ ordre: 1, text: "ok" }]);
  assert.deepEqual(result.entryErrors, [{ ordre: 2, error: "http_500" }]);
});

test("parseOcrOutput drops a hallucinated page into dropped.hallucinated", () => {
  const repeated = Array.from({ length: 6 }, () => "This is a repeated filler line.").join("\n");
  const jsonl = [line("f1", "Vrai texte de la page"), line("f2", repeated)].join("\n");
  const result = parseOcrOutput(jsonl);
  assert.deepEqual(result.pages, [{ ordre: 1, text: "Vrai texte de la page" }]);
  assert.deepEqual(result.dropped, { empty: 0, hallucinated: 1 });
});

test("parseOcrOutput: all pages hallucinated → zero pages, dropped.hallucinated == count", () => {
  const repeated = Array.from({ length: 6 }, () => "This is a repeated filler line.").join("\n");
  const jsonl = [line("f1", repeated), line("f2", repeated)].join("\n");
  const result = parseOcrOutput(jsonl);
  assert.deepEqual(result.pages, []);
  assert.deepEqual(result.dropped, { empty: 0, hallucinated: 2 });
});

test("parseOcrOutput: mixed drop causes are all counted independently", () => {
  const repeated = Array.from({ length: 6 }, () => "This is a repeated filler line.").join("\n");
  const jsonl = [
    line("f1", "Vrai texte"),
    line("f2", repeated), // hallucinated
    line("f3", ""), // empty
    JSON.stringify({ custom_id: "f4", error: "boom" }), // entry error
  ].join("\n");
  const result = parseOcrOutput(jsonl);
  assert.deepEqual(result.pages, [{ ordre: 1, text: "Vrai texte" }]);
  assert.deepEqual(result.dropped, { empty: 1, hallucinated: 1 });
  assert.equal(result.entryErrors.length, 1);
  assert.equal(result.entryErrors[0]?.ordre, 4);
});

test("looksLikeHallucinatedOcr: repeated long line ≥4× is flagged", () => {
  const md = Array.from({ length: 5 }, () => "Une longue ligne répétée encore.").join("\n");
  assert.equal(looksLikeHallucinatedOcr(md), true);
});

test("looksLikeHallucinatedOcr: filler markers ≥2 are flagged", () => {
  const md = ["cannot be extracted from here", "this is a simple diagram of nothing"].join("\n");
  assert.equal(looksLikeHallucinatedOcr(md), true);
});

test("looksLikeHallucinatedOcr: genuine prose is not flagged", () => {
  const md = [
    "Le manuscrit décrit les fortifications de la ville.",
    "Une carte détaillée accompagne le texte principal.",
    "Les annotations marginales sont nombreuses et précises.",
  ].join("\n");
  assert.equal(looksLikeHallucinatedOcr(md), false);
});

test("buildBatchJsonl: one valid JSONL line per folio, custom_id carries ordre", () => {
  const folios = [
    { ordre: 1, image: Buffer.from("img-one") },
    { ordre: 7, image: Buffer.from("img-seven") },
  ];
  const out = buildBatchJsonl("ark:/12148/btv1b000", folios);
  const lines = out.toString("utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!);
  assert.equal(first.custom_id, "f1");
  assert.equal(
    first.body.document.image_url,
    `data:image/jpeg;base64,${Buffer.from("img-one").toString("base64")}`,
  );
  assert.equal(JSON.parse(lines[1]!).custom_id, "f7");
});

test("buildBatchJsonl: empty folio list yields an empty buffer", () => {
  assert.equal(buildBatchJsonl("ark:/12148/x", []).length, 0);
});

test("buildBatchJsonl: oversized batch throws an attributable error (no V8 crash)", () => {
  // A single ~6MB image; 300 of them (~1.8GB base64) exceeds the safe ceiling.
  const big = Buffer.alloc(6 * 1024 * 1024, 0x41);
  const folios = Array.from({ length: 300 }, (_, i) => ({ ordre: i + 1, image: big }));
  assert.throws(
    () => buildBatchJsonl("ark:/12148/huge", folios),
    /ark:\/12148\/huge batch input exceeds .* bytes/,
  );
});

// ── LiveOcrEngine.pollBatch — terminal-state honesty (F14) ──────────────────

test("pollBatch: non-terminal status → pending (no download attempted)", async () => {
  const engine = new LiveOcrEngine(
    stubMistral({ status: "RUNNING", succeededRequests: 0, failedRequests: 0, totalRequests: 6 }),
  );
  const status = await engine.pollBatch("batch-1");
  assert.equal(status.state, "pending");
});

test("pollBatch: TIMEOUT_EXCEEDED WITH an outputFile still returns failed, never done", async () => {
  const engine = new LiveOcrEngine(
    stubMistral(
      {
        status: "TIMEOUT_EXCEEDED",
        outputFile: "file-partial",
        succeededRequests: 2,
        failedRequests: 0,
        totalRequests: 6,
      },
      line("f1", "would-be page text"), // a partial output IS attached — must be ignored
    ),
  );
  const status = await engine.pollBatch("batch-2");
  assert.equal(status.state, "failed", "a non-SUCCESS terminal state is ALWAYS failed");
  if (status.state !== "failed") return;
  assert.match(status.reason, /TIMEOUT_EXCEEDED/);
  assert.match(status.reason, /2\/6 succeeded/);
});

test("pollBatch: FAILED with no outputFile → failed, with succeeded/failed counts in the reason", async () => {
  const engine = new LiveOcrEngine(
    stubMistral({
      status: "FAILED",
      outputFile: null,
      succeededRequests: 0,
      failedRequests: 6,
      totalRequests: 6,
    }),
  );
  const status = await engine.pollBatch("batch-3");
  assert.equal(status.state, "failed");
  if (status.state !== "failed") return;
  assert.match(status.reason, /FAILED/);
  assert.match(status.reason, /6 failed/);
});

test("pollBatch: SUCCESS but no outputFile → failed (never fabricates empty pages)", async () => {
  const engine = new LiveOcrEngine(
    stubMistral({
      status: "SUCCESS",
      outputFile: null,
      succeededRequests: 6,
      failedRequests: 0,
      totalRequests: 6,
    }),
  );
  const status = await engine.pollBatch("batch-4");
  assert.equal(status.state, "failed");
});

test("pollBatch: SUCCESS with failedRequests > 0 → done, with honest counts + parsed pages", async () => {
  const jsonl = [line("f1", "Vrai texte de la page")].join("\n");
  const engine = new LiveOcrEngine(
    stubMistral(
      { status: "SUCCESS", outputFile: "file-1", succeededRequests: 5, failedRequests: 1, totalRequests: 6 },
      jsonl,
    ),
  );
  const status = await engine.pollBatch("batch-5");
  assert.equal(status.state, "done");
  if (status.state !== "done") return;
  assert.equal(status.succeeded, 5);
  assert.equal(status.failed, 1);
  assert.deepEqual(status.pages, [{ ordre: 1, text: "Vrai texte de la page" }]);
  assert.deepEqual(status.dropped, { empty: 0, hallucinated: 0 });
});
