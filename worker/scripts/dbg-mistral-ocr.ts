/**
 * Throwaway diagnostic: does Mistral OCR per-page confidence cleanly separate
 * good folios from blank-page hallucinations?
 *
 *   npm run dbg:mistral -- <ARK> [folioCount] [model]
 *
 * Sync-OCRs folios 1..N with confidence_scores_granularity=page and tabulates
 * avg/min confidence, length, top-line repetition, and a snippet — so we can
 * pick a confidence threshold (and/or repetition guard) before scaling.
 */
interface ProcessWithEnvFile {
  loadEnvFile?: (path?: string) => void;
}
const proc: ProcessWithEnvFile = process;
if (typeof proc.loadEnvFile === "function") {
  try {
    proc.loadEnvFile(".env");
  } catch {
    // env expected to be set externally
  }
}

import { Mistral } from "@mistralai/mistralai";
import { BnfApi } from "../src/prepare/bnf-api.js";
import { fetchImage } from "../src/prepare/vision.js";
import { looksLikeHallucinatedOcr } from "../src/prepare/mistral-ocr.js";
import { mistralOcr } from "../src/env.js";

/** Fraction of non-empty lines taken by the single most-repeated line. */
function topLineRepeatRatio(markdown: string): number {
  const lines = markdown
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const max = Math.max(...counts.values());
  return max / lines.length;
}

async function main(): Promise<void> {
  const [, , ark, countRaw, modelArg] = process.argv;
  if (!ark || !ark.startsWith("ark:/12148/")) {
    console.error('Usage: npm run dbg:mistral -- "ark:/12148/<id>" [folioCount] [model]');
    process.exit(2);
  }
  const count = Math.max(1, Number(countRaw ?? 5));
  const model = modelArg ?? mistralOcr.model();

  const bnf = new BnfApi();
  const client = new Mistral({ apiKey: mistralOcr.apiKey() });
  try {
    const manifest = await bnf.getManifest(ark, { maxCanvases: count });
    console.log(`[dbg] ${ark} — ${manifest.canvases.length} canvas(es), model=${model}\n`);
    console.log("folio | avgConf | minConf | chars | rep% | GUARD | snippet");
    console.log("------|---------|---------|-------|------|-------|--------");

    for (const canvas of manifest.canvases.slice(0, count)) {
      const url = await bnf.getImageUrl(ark, { ordre: canvas.ordre, size: "!2000,2000" });
      const img = await fetchImage(url);
      const res = await client.ocr.process({
        model,
        document: { type: "image_url", imageUrl: img.dataUrl },
        confidenceScoresGranularity: "page",
      });
      const page = res.pages[0];
      const md = page?.markdown ?? "";
      const conf = page?.confidenceScores;
      const avg = conf ? conf.averagePageConfidenceScore.toFixed(3) : "  n/a";
      const min = conf ? conf.minimumPageConfidenceScore.toFixed(3) : "  n/a";
      const rep = (topLineRepeatRatio(md) * 100).toFixed(0).padStart(3);
      const guard = looksLikeHallucinatedOcr(md) ? "DROP " : "keep ";
      const snippet = md.replace(/\s+/g, " ").trim().slice(0, 50);
      console.log(
        `f${String(canvas.ordre).padEnd(4)} | ${avg.padStart(7)} | ${min.padStart(7)} | ${String(md.length).padStart(5)} | ${rep}% | ${guard} | ${snippet}`,
      );
      // Dump suspicious (high-repetition) pages in full so we can eyeball them.
      if (topLineRepeatRatio(md) > 0.3) {
        console.log(`\n----- f${canvas.ordre} FULL (rep ${rep}%) -----\n${md}\n----- end f${canvas.ordre} -----\n`);
      }
    }
  } finally {
    await bnf.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[dbg] FAILED:", e instanceof Error ? e.stack : e);
  process.exit(2);
});
