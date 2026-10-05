// lib/cluster/ocr-quality-contract.test.ts
// THE VERSION RULE, enforced (pass-6 item 5): the per-ARK artifact schema the
// app reads is fingerprinted — its JSON-schema serialisation, hashed — and the
// fingerprint is committed here, keyed by OCR_QUALITY_ARTIFACT_VERSION. A
// change to the schema without a new version AND a new entry fails this test;
// so does a version bump without one. The fingerprint covers the shape (fields,
// types, ranges, enums, the `v` constant); the cross-field refinements (a
// folio's source matches its lane, folios unique) are covered by the
// behaviour tests in tests/models/documents/ocr.test.ts.
//
// When this fails because you changed the artifact on purpose: bump
// OCR_QUALITY_ARTIFACT_VERSION here AND in worker-v2/src/domain/types.ts, then
// add the new fingerprint below (helm/DEPLOY.md, "The artifact version rule").
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { z } from "zod"

import { OCR_QUALITY_ARTIFACT_VERSION, workerDocOcrQualitySchema } from "./ocr-quality"

/** Committed fingerprints of the artifact schema, one per artifact version. */
const ARTIFACT_SCHEMA_FINGERPRINTS: Readonly<Record<number, string>> = {
  1: "4ab32b8df6a78dc81c5f35533cdf332881437dcfaea62a0b63c1482a8740346a",
}

function fingerprint(schema: z.ZodType): string {
  return createHash("sha256").update(JSON.stringify(z.toJSONSchema(schema))).digest("hex")
}

test("the artifact schema matches the fingerprint committed for its version", () => {
  const committed = ARTIFACT_SCHEMA_FINGERPRINTS[OCR_QUALITY_ARTIFACT_VERSION]
  assert.ok(committed !== undefined, `no fingerprint committed for artifact v${OCR_QUALITY_ARTIFACT_VERSION}`)
  assert.equal(
    fingerprint(workerDocOcrQualitySchema),
    committed,
    "the artifact schema changed without a version bump (see the header of this file)",
  )
})

test("the fingerprinted serialisation carries the version and every field, so a bump or a field change moves it", () => {
  const json = z.toJSONSchema(workerDocOcrQualitySchema)
  assert.equal(json.type, "object")
  const properties = json.properties ?? {}
  assert.deepEqual(Object.keys(properties).sort(), ["ark", "builtAt", "folios", "lane", "ocrRate", "v"])
  assert.deepEqual(properties.v, { type: "number", const: OCR_QUALITY_ARTIFACT_VERSION })
})
