/**
 * Pure-logic test for the live embedder's dim guard.
 *
 * The RunPod HTTP call itself is not exercised (network). We inject a stub
 * `RunpodBgeM3` to verify the pass-through and the width assertion: a vector
 * whose length doesn't match the declared `dim` must throw rather than ship a
 * mislabelled embedding.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { RunpodBgeM3 } from "./vendor/runpod.js";
import { BGE_M3_DIM, LiveEmbedder } from "./embedder.js";

/** Minimal stub typed as RunpodBgeM3 — only `embed` is reached. */
function stubInner(vectors: number[][]): RunpodBgeM3 {
  return { embed: async () => vectors } as unknown as RunpodBgeM3;
}

test("LiveEmbedder declares the bge-m3 width and passes vectors through", async () => {
  const vec = Array.from({ length: BGE_M3_DIM }, (_, i) => i);
  const e = new LiveEmbedder(stubInner([vec]));
  assert.equal(e.dim, BGE_M3_DIM);
  const out = await e.embed(["x"]);
  assert.deepEqual(out, [vec]);
});

test("LiveEmbedder throws on a width mismatch (model swap guard)", async () => {
  const e = new LiveEmbedder(stubInner([[1, 2, 3]])); // 3 ≠ 1024
  await assert.rejects(() => e.embed(["x"]), /dim mismatch/);
});

test("LiveEmbedder tolerates an empty input (no vectors, no throw)", async () => {
  const e = new LiveEmbedder(stubInner([]));
  assert.deepEqual(await e.embed([]), []);
});
