// lib/env.ts boot schema — the BnF Presentation base is required exactly when
// the broker is configured: the broker path resolves Gallica documents from
// their manifest, which lives on the Presentation API, so a broker without it
// must refuse to boot instead of failing every resolution at runtime.
import { test } from "node:test"
import assert from "node:assert/strict"

import { bootEnvSchema } from "@/lib/env"

/** The required vars only — no broker, no MCP, no SSO. */
const validBase = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  ANTHROPIC_API_KEY: "test-key",
  APP_URL: "http://localhost:3000",
  BNF_API_BASE_URL: "https://openapiproext.bnf.fr",
}
const PRESENTATION = "https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0"

test("a broker without the Presentation base refuses to boot, naming the variable", () => {
  const parsed = bootEnvSchema.safeParse({ ...validBase, BNF_BROKER_URL: "http://b:8792" })
  assert.equal(parsed.success, false)
  const issue = parsed.error?.issues.find((i) => i.path.join(".") === "BNF_IIIF_PRESENTATION_BASE_URL")
  assert.ok(issue, `an issue on BNF_IIIF_PRESENTATION_BASE_URL, got ${JSON.stringify(parsed.error?.issues)}`)
  assert.match(issue.message, /required when BNF_BROKER_URL is set/)
})

test("a broker with the Presentation base boots", () => {
  const parsed = bootEnvSchema.safeParse({
    ...validBase,
    BNF_BROKER_URL: "http://b:8792",
    BNF_IIIF_PRESENTATION_BASE_URL: PRESENTATION,
  })
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
})

test("no broker, no Presentation base: boots (the dev path resolves via the ungated hosts)", () => {
  assert.equal(bootEnvSchema.safeParse(validBase).success, true)
})

test("a malformed Presentation base is refused even without a broker", () => {
  assert.equal(bootEnvSchema.safeParse({ ...validBase, BNF_IIIF_PRESENTATION_BASE_URL: "not a url" }).success, false)
})
