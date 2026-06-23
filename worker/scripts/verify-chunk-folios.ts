/**
 * Invariant check for the folio-aware chunker.
 *
 * The whole "click → exact page" citation promise rests on one rule: a chunk
 * must belong to exactly ONE folio. If a chunk spans a `## Folio N` boundary,
 * every passage drawn from it inherits the wrong page number (the off-by-one
 * citation bug). This script builds synthetic multi-folio markdown with pages
 * deliberately longer than the chunk target — the case that used to spill — and
 * asserts no chunk contains a second `## Folio` heading.
 *
 * Run: npx tsx scripts/verify-chunk-folios.ts
 */
import { chunkMarkdown } from "../src/prepare/chunk.js";

const FOLIO_IN_BODY = /(^|\n)##\s+Folio\s+\d+\b/;

/** Repeat a sentence until it comfortably exceeds the chunk target size. */
function longPage(seed: string, approxChars: number): string {
  let out = "";
  let i = 0;
  while (out.length < approxChars) {
    out += `${seed} (paragraphe ${++i}).\n\n`;
  }
  return out.trim();
}

function buildDoc(folioCount: number, pageChars: number): string {
  const parts: string[] = ["# Document de test", "", "**ARK :** ark:/12148/bpt6ktest", ""];
  for (let f = 1; f <= folioCount; f++) {
    parts.push(`## Folio ${f}`);
    parts.push("");
    parts.push(longPage(`Texte OCR de la vue ${f}`, pageChars));
    parts.push("");
  }
  return parts.join("\n");
}

interface Failure {
  scenario: string;
  detail: string;
}

const failures: Failure[] = [];

function check(scenario: string, markdown: string): void {
  const baseMetadata = { ark: "ark:/12148/bpt6ktest", arkSlug: "bpt6ktest" };
  const chunks = chunkMarkdown(markdown, { baseMetadata });

  for (const c of chunks) {
    // A chunk may legitimately START with its folio heading; what it must never
    // do is contain a *second* `## Folio` heading further in. Strip the first
    // line before scanning so a leading heading doesn't false-positive.
    const afterFirstLine = c.text.slice(c.text.indexOf("\n") + 1);
    if (FOLIO_IN_BODY.test(afterFirstLine)) {
      failures.push({
        scenario,
        detail: `chunk ${c.chunkIndex} (folio=${String(
          c.metadata.folio,
        )}) spans a folio boundary:\n${c.text.slice(0, 160)}…`,
      });
    }
    // The slice offsets must address the original markdown verbatim.
    if (markdown.slice(c.charStart, c.charEnd).trim() !== c.text) {
      failures.push({
        scenario,
        detail: `chunk ${c.chunkIndex} char range [${c.charStart},${c.charEnd}] does not match its text`,
      });
    }
  }

  // Every text-bearing folio must be represented by at least one chunk.
  const stampedFolios = new Set(
    chunks.map((c) => c.metadata.folio).filter((f): f is number => typeof f === "number"),
  );
  const declaredFolios = [...markdown.matchAll(/(^|\n)##\s+Folio\s+(\d+)\b/g)].map((m) =>
    Number(m[2]),
  );
  for (const f of declaredFolios) {
    if (!stampedFolios.has(f)) {
      failures.push({ scenario, detail: `folio ${f} produced no chunk` });
    }
  }

  console.log(
    `  ${scenario}: ${chunks.length} chunks, folios ${[...stampedFolios].sort((a, b) => a - b).join(",")}`,
  );
}

console.log("Chunker folio-boundary invariant:");
check("long pages (spill case)", buildDoc(5, 3000));
check("short pages", buildDoc(6, 200));
check("single huge page", buildDoc(1, 8000));
check("uneven pages", `${buildDoc(3, 2500)}\n## Folio 4\n\nUne seule ligne.\n`);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} invariant violation(s):`);
  for (const f of failures) console.error(`  [${f.scenario}] ${f.detail}`);
  process.exit(1);
}
console.log("\n✓ No chunk spans a folio boundary; offsets and coverage hold.");
