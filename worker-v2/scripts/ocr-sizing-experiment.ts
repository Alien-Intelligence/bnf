/**
 * OCR sizing experiment (ingest-hardening Slice 4 validation).
 *
 * Hypothesis: Mistral OCR hallucinates on FULL-RES 1949 Nice-Matin broadsheets
 * (prod forensics: ×698 repeated lines, CJK boilerplate — all 6 pages of the 28
 * `ocr_no_text` docs dropped by the hallucination filter, and the 32 "done"
 * siblings kept only a fraction). The vision lane already downscales (pct:33)
 * for analogous reasons. This measures whether pct:50 materially reduces the
 * hallucinated-page drop rate, to decide MISTRAL_IMAGE_SIZE.
 *
 * Run from worker-v2/:
 *   BNF_BROKER_URL=http://localhost:8793 npx tsx --env-file=.env \
 *     scripts/ocr-sizing-experiment.ts
 * (the :8793 port-forward is the platform-dev validation broker — greenlighted
 *  egress; the dev machine's own IP 401s at BnF.)
 *
 * Spend: 3 ARKs × 6 folios × 2 sizes = 36 Mistral OCR pages ≈ $0.08.
 * Read-only against BnF (image GETs, on the 1000/min global budget).
 */
import { LiveBnfClient } from "../src/bnf/client.js";
import { LiveOcrEngine } from "../src/live/ocr.js";

const ARKS = [
  "ark:/12148/bd6t528821133",
  "ark:/12148/bd6t52879390g",
  "ark:/12148/bd6t528793781",
];
const SIZES = ["max", "pct:50"] as const;
const FOLIOS = [1, 2, 3, 4, 5, 6];
const POLL_MS = 20_000;
const CEILING_MS = 40 * 60 * 1000;

async function main(): Promise<void> {
  const bnf = new LiveBnfClient();
  const ocr = new LiveOcrEngine();

  // 1. Fetch every folio at every size (sequential — politeness over speed).
  const images = new Map<string, Array<{ ordre: number; image: Buffer }>>();
  for (const size of SIZES) {
    for (const ark of ARKS) {
      const folios: Array<{ ordre: number; image: Buffer }> = [];
      for (const ordre of FOLIOS) {
        const bytes = await bnf.fetchImageFolio(ark, ordre, size);
        folios.push({ ordre, image: bytes });
      }
      const totalMb = folios.reduce((n, f) => n + f.image.length, 0) / 1e6;
      console.log(`[fetch] ${ark} @ ${size}: 6 folios, ${totalMb.toFixed(1)} MB`);
      images.set(`${ark}|${size}`, folios);
    }
  }

  // 2. Submit one batch per (ark, size).
  const batches: Array<{ key: string; batchId: string }> = [];
  for (const [key, folios] of images) {
    const { batchId } = await ocr.submitBatch({ ark: key, folios });
    console.log(`[submit] ${key} → ${batchId}`);
    batches.push({ key, batchId });
  }

  // 3. Poll all to terminal (bounded).
  const deadline = Date.now() + CEILING_MS;
  const results = new Map<string, { kept: number; hallucinated: number; empty: number; errors: number }>();
  const pending = new Set(batches.map((b) => b.key));
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      console.error(`CEILING — still pending: ${[...pending].join(", ")}`);
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    for (const { key, batchId } of batches) {
      if (!pending.has(key)) continue;
      const status = await ocr.pollBatch(batchId);
      if (status.state === "pending") continue;
      pending.delete(key);
      if (status.state === "failed") {
        console.log(`[done] ${key}: BATCH FAILED — ${status.reason}`);
        results.set(key, { kept: -1, hallucinated: -1, empty: -1, errors: -1 });
      } else {
        results.set(key, {
          kept: status.pages.length,
          hallucinated: status.dropped.hallucinated,
          empty: status.dropped.empty,
          errors: status.entryErrors.length,
        });
        console.log(
          `[done] ${key}: kept=${status.pages.length}/6 hallucinated=${status.dropped.hallucinated} empty=${status.dropped.empty} entryErrors=${status.entryErrors.length}`,
        );
      }
    }
  }

  // 4. Verdict table.
  console.log("\n=== RESULTS (kept/6 per doc) ===");
  console.log("ark".padEnd(30) + SIZES.map((s) => s.padEnd(10)).join(""));
  for (const ark of ARKS) {
    const row = SIZES.map((s) => {
      const r = results.get(`${ark}|${s}`);
      return (r ? `${r.kept}/6` : "?").padEnd(10);
    });
    console.log(ark.replace("ark:/12148/", "").padEnd(30) + row.join(""));
  }
  for (const size of SIZES) {
    let kept = 0,
      total = 0;
    for (const ark of ARKS) {
      const r = results.get(`${ark}|${size}`);
      if (r && r.kept >= 0) {
        kept += r.kept;
        total += 6;
      }
    }
    console.log(`${size}: ${kept}/${total} pages usable`);
  }
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
