// presentationManifestUrl — the resolver's manifest URL on the BnF Presentation
// API (Swagger PRESENTATION_IIIF_GALLICA, 2026-09-30), not the legacy combined
// Gallica-IIIF path (`/iiif/presentation/v3/…`) the resolver used to build.
import { test } from "node:test"
import assert from "node:assert/strict"

import { presentationManifestUrl } from "@/lib/bnf/endpoints"

test("presentationManifestUrl builds the exact Swagger path on the Presentation base", () => {
  assert.equal(
    presentationManifestUrl(
      "https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0/",
      "ark:/12148/bpt6k4625753w",
    ),
    "https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0/presentation/v3/ark:/12148/bpt6k4625753w/manifest.json",
  )
})

test("presentationManifestUrl: the base with or without a trailing slash gives the same URL", () => {
  const ark = "ark:/12148/btv1b8470216w"
  assert.equal(
    presentationManifestUrl("https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0", ark),
    presentationManifestUrl("https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0/", ark),
  )
})
