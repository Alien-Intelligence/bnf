/**
 * The worker's BnF gate composition (buildRateGates) — the 0.19.1 fix. In
 * 0.19.0 ALTO's gate was presentation ∧ global, so ALTO alone could take the
 * whole global budget and the broker shed the same ingest's manifest lookups.
 * A composite's ratePerMin is the minimum of its parts, so the effective
 * rates pin the composition: reverting to the 0.19.0 wiring turns this red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRateGates } from "./live-pipeline.js";

const RATES = {
  globalRpm: 950,
  presentationRpm: 1425,
  imageRpm: 285,
  manifestRpm: 38,
  catalogueRpm: 95,
  grapheDataRpm: 47,
  bulkRpm: 770,
  workerManifestRpm: 28,
};

test("ALTO and image run under the bulk limit; manifests under the worker's share", () => {
  const { gates } = buildRateGates(RATES);
  assert.equal(gates.fetchAlto.ratePerMin, 770, "ALTO: min(presentation, bulk, global) — 950 under 0.19.0");
  assert.equal(gates.fetchImage.ratePerMin, 285, "images: the Image quota stays binding");
  assert.equal(gates.manifest.ratePerMin, 28, "manifests: the worker's share — 38 under 0.19.0");
});

test("the bulk limiter is among the limiters shutdown stops", () => {
  const { limiters } = buildRateGates(RATES);
  assert.deepEqual(
    limiters.map((l) => l.ratePerMin).sort((a, b) => a - b),
    [28, 285, 770, 950, 1425],
  );
});
