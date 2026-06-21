/**
 * Smoke test for Track 3 embedder.
 *
 *   npm run embed:one
 *
 * Sends a small canned French batch through RunPod bge-m3 and prints
 * shape + latency + the first few floats. Requires RUNPOD_API_KEY and
 * RUNPOD_EMBEDDING_ENDPOINT_ID in .env (no cluster envs needed).
 */
import { RunpodBgeM3 } from "../src/embed/runpod.js";

const TEXTS = [
  "Bonjour le monde.",
  "La Bibliothèque nationale de France conserve des millions de documents.",
  "Gallica est la bibliothèque numérique de la BnF.",
  "ark:/12148/btv1b9015469h désigne un document unique et stable dans le temps.",
  "Le folio est la page physique du document, indispensable pour la citation.",
];

async function main(): Promise<void> {
  const embedder = new RunpodBgeM3();
  console.log(`Embedding ${TEXTS.length} texts via RunPod bge-m3...`);
  const t0 = Date.now();
  const vectors = await embedder.embed(TEXTS);
  const elapsed = Date.now() - t0;

  console.log(`OK  vectors=${vectors.length}  latency=${elapsed}ms`);
  const first = vectors[0];
  if (!first) {
    throw new Error("No vectors returned");
  }
  console.log(`    dim=${first.length}`);
  console.log(`    first6=[${first.slice(0, 6).map((x) => x.toFixed(6)).join(", ")}]`);
  // Sanity: all vectors same dim
  const dims = new Set(vectors.map((v) => v.length));
  console.log(`    unique dims=${[...dims].join(",")}`);
}

main().catch((err) => {
  console.error("embed:one failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
