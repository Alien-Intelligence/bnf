/**
 * normalizeCachedDocInfo — the ONE way a cached `meta/<slug>.json` blob is read
 * back into a BnfDocInfo. Blobs written before the OCR-quality release carry no
 * `ocrRate`; manifest-sourced ones still hold the full manifest metadata pairs
 * under `raw.metadata`, so the value is recoverable without a BnF call (plan
 * D5). A blob with an `ocrRate` of the wrong type is a corrupt cache entry and
 * must throw — never be coerced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeCachedDocInfo } from "./doc-info.js";

const ARK = "ark:/12148/bpt6k4625753w";

/** A pre-release blob exactly as docInfoFromManifest wrote it (no ocrRate). */
function legacyManifestBlob(metadata: Array<{ label: string; value: string }>) {
  return {
    ark: ARK,
    title: "L'Auto-vélo",
    creator: null,
    date: "1910-07-02",
    docType: "texte | publication en série imprimée",
    subtype: null,
    ocrAvailable: true,
    pageCount: 8,
    iiifManifestUrl: `https://openapiproext.bnf.fr/iiif/presentation/v3/${ARK}/manifest.json`,
    lang: "fre",
    raw: {
      source: "iiif_manifest",
      type_document: "texte",
      type: "publication en série imprimée",
      language: "fre",
      pageNumber: 8,
      metadata,
    },
  };
}

test("legacy manifest-sourced blob without ocrRate → derived from raw.metadata Taux OCR", () => {
  const info = normalizeCachedDocInfo(
    legacyManifestBlob([
      { label: "Titre", value: "L'Auto-vélo" },
      { label: "Taux OCR", value: "78.21 %" },
    ]),
  );
  assert.equal(info.ocrRate, 0.7821);
  assert.equal(info.ark, ARK);
  assert.equal(info.ocrAvailable, true, "every other field passes through untouched");
});

test("legacy manifest-sourced blob whose metadata has no Taux OCR → null", () => {
  const info = normalizeCachedDocInfo(
    legacyManifestBlob([{ label: "Type document", value: "Carte" }]),
  );
  assert.equal(info.ocrRate, null);
});

test("legacy OAI-sourced blob → ocrRate null (OAI carries no Taux OCR)", () => {
  const info = normalizeCachedDocInfo({
    ark: ARK,
    title: "Un titre",
    creator: null,
    date: null,
    docType: "texte",
    subtype: "fascicules",
    ocrAvailable: true,
    pageCount: 12,
    iiifManifestUrl: null,
    lang: "fre",
    raw: { source: "oai_pmh", "dc:title": ["Un titre"], language: "fre", pageNumber: 12 },
  });
  assert.equal(info.ocrRate, null);
});

test("current blob with ocrRate 0.5 → unchanged", () => {
  const info = normalizeCachedDocInfo({
    ...legacyManifestBlob([{ label: "Taux OCR", value: "99 %" }]),
    ocrRate: 0.5,
  });
  assert.equal(info.ocrRate, 0.5, "a present value wins over re-deriving from raw.metadata");
});

test("current blob with ocrRate null → unchanged (null is a valid recorded value)", () => {
  const info = normalizeCachedDocInfo({
    ...legacyManifestBlob([{ label: "Taux OCR", value: "99 %" }]),
    ocrRate: null,
  });
  assert.equal(info.ocrRate, null);
});

test("blob whose ocrRate is a string → throws (corrupt cache, never coerced)", () => {
  assert.throws(
    () => normalizeCachedDocInfo({ ...legacyManifestBlob([]), ocrRate: "0.78" }),
    /ocrRate/,
  );
});

test("blob that is not a BnfDocInfo at all → throws", () => {
  assert.throws(() => normalizeCachedDocInfo(null), /cached BnfDocInfo/);
  assert.throws(() => normalizeCachedDocInfo("nope"), /cached BnfDocInfo/);
  assert.throws(() => normalizeCachedDocInfo({ title: "no ark" }), /cached BnfDocInfo/);
});
