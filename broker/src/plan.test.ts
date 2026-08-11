/**
 * Unit tests for `planFor` (plan.ts) — the F5 manifest/global budget isolation.
 *
 * `plan.ts` imports `config.ts`, which throws at module-load time if the BnF
 * OAuth client credentials aren't set (no defaults for secrets, per
 * CLAUDE_ERROR_PATTERNS §10). These tests never make a network call, so a
 * pair of dummy values is enough — set BEFORE the dynamic import below (a
 * static top-level import would run before this file's own code, since ESM
 * hoists imports).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BNF_CLIENT_KEY ??= "test-client-key";
process.env.BNF_CLIENT_SECRET ??= "test-client-secret";

const { planFor } = await import("./plan.js");

test("manifest URL on the partner API -> acquire/penalize exactly [manifest], authed", () => {
  const target = new URL(
    "https://openapiproext.bnf.fr/iiif/presentation/v3/ark:/12148/bpt6k123456/manifest.json",
  );
  const plan = planFor(target);
  assert.deepEqual(plan.acquire, ["manifest"], "acquires ONLY the manifest bucket");
  assert.deepEqual(plan.penalize, ["manifest"], "penalizes ONLY the manifest bucket");
  assert.equal(plan.auth, true, "partner API calls carry the bearer token");
});

test("non-manifest partner-API URL -> acquire/penalize exactly [global], authed", () => {
  const target = new URL("https://openapiproext.bnf.fr/some/other/endpoint");
  const plan = planFor(target);
  assert.deepEqual(plan.acquire, ["global"], "acquires ONLY the global bucket — never touches manifest");
  assert.deepEqual(plan.penalize, ["global"], "penalizes ONLY the global bucket");
  assert.equal(plan.auth, true);
});

test("ungated oai/gallica URL -> acquire/penalize exactly [external], not authed", () => {
  const target = new URL("https://oai.bnf.fr/oai2/OAIHandler?verb=GetRecord");
  const plan = planFor(target);
  assert.deepEqual(plan.acquire, ["external"]);
  assert.deepEqual(plan.penalize, ["external"]);
  assert.equal(plan.auth, false, "ungated hosts get no bearer token");
});

test("a manifest.json path on a NON-partner host is NOT routed to the manifest bucket", () => {
  // isManifest() alone would match the path; isPartnerApi() gates it — a
  // manifest-shaped URL on an ungated host (shouldn't occur in practice, but
  // proves the two checks compose as `isPartnerApi && isManifest`, not
  // `isManifest` alone).
  const target = new URL("https://gallica.bnf.fr/iiif/presentation/v3/ark:/12148/x/manifest.json");
  const plan = planFor(target);
  assert.deepEqual(plan.acquire, ["external"]);
  assert.equal(plan.auth, false);
});
