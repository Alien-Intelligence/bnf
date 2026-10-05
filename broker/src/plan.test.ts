/**
 * planFor (plan.ts) — the ingestion subscription's per-API model: which
 * buckets a request acquires, which one its 429 freezes, which label the call
 * log shows, and which partner paths are refused.
 *
 * plan.ts is pure (the partner host is a parameter), so no env is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { planFor, type Plan } from "./plan.js";

const HOST = "openapiproext.bnf.fr";
const PRES = `https://${HOST}/presentation/iiif/gallica/1.0.0/presentation/v3/ark:/12148/bpt6k4625753w`;
const IMAGE = `https://${HOST}/image/iiif/gallica/1.0.0/image/v3/ark:/12148/bpt6k4625753w`;

/** The plan of a URL that must be sent (fails the test on a reject). */
function sendPlan(url: string): Extract<Plan, { kind: "send" }> {
  const plan = planFor(new URL(url), HOST);
  assert.equal(plan.kind, "send", `${url} must be sent, got ${JSON.stringify(plan)}`);
  if (plan.kind !== "send") throw new Error("unreachable");
  return plan;
}

test("a new Presentation manifest takes manifest → presentation → global; a 429 freezes the manifest bucket", () => {
  const plan = sendPlan(`${PRES}/manifest.json`);
  assert.deepEqual(plan.acquire, ["manifest", "presentation", "global"]);
  assert.equal(plan.penalize, "manifest");
  assert.equal(plan.label, "manifest");
  assert.equal(plan.auth, true);
});

test("a new Presentation ALTO takes presentation → global; a 429 freezes presentation, never global", () => {
  const plan = sendPlan(`${PRES}/f1/alto.xml`);
  assert.deepEqual(plan.acquire, ["presentation", "global"]);
  assert.equal(plan.penalize, "presentation");
  assert.equal(plan.label, "presentation");
});

test("a new Image API folio takes image → global and freezes image", () => {
  const plan = sendPlan(`${IMAGE}/f1/full/!4096,4096/0/default.jpg`);
  assert.deepEqual(plan.acquire, ["image", "global"]);
  assert.equal(plan.penalize, "image");
  assert.equal(plan.label, "image");
});

test("a legacy Gallica-IIIF manifest is still a manifest, on the iiifLegacy bucket", () => {
  const plan = sendPlan(`https://${HOST}/iiif/presentation/v3/ark:/12148/bpt6k123456/manifest.json`);
  assert.deepEqual(plan.acquire, ["manifest", "iiifLegacy", "global"]);
  assert.equal(plan.penalize, "manifest");
});

test("F-D1: a catalogue SRU 429 freezes the catalogue bucket, not the ingestion's global", () => {
  const plan = sendPlan(`https://${HOST}/catalogueservice-cons/1.0/SRU?version=1.2&operation=searchRetrieve`);
  assert.deepEqual(plan.acquire, ["catalogue", "global"]);
  assert.equal(plan.penalize, "catalogue");
});

test("data.bnf SPARQL is the grapheData bucket", () => {
  const plan = sendPlan(`https://${HOST}/graphe/data/1.0.0/sparql?query=x`);
  assert.deepEqual(plan.acquire, ["grapheData", "global"]);
  assert.equal(plan.penalize, "grapheData");
});

test("the remaining partner APIs each have their own bucket", () => {
  assert.deepEqual(sendPlan(`https://${HOST}/recherche/sru/gallica/1.0/sru?q`).acquire, ["gallicaSru", "global"]);
  assert.deepEqual(sendPlan(`https://${HOST}/date/periodique/gallica/1.0/Issues`).acquire, ["datePeriodique", "global"]);
  assert.deepEqual(sendPlan(`https://${HOST}/document/tdm/gallica/1.0/toc`).acquire, ["documentTdm", "global"]);
});

test("a version bump of an API still classifies (prefixes exclude the version segment)", () => {
  const plan = sendPlan(
    `https://${HOST}/presentation/iiif/gallica/1.0.1/presentation/v3/ark:/12148/bpt6k4625753w/f2/alto.xml`,
  );
  assert.deepEqual(plan.acquire, ["presentation", "global"]);
});

test("a partner-host path outside every known API is rejected, never charged to a default bucket", () => {
  assert.deepEqual(planFor(new URL(`https://${HOST}/unknown/api/x`), HOST), {
    kind: "reject",
    reason: "unclassified_partner_path",
  });
  // "/image/…" alone is not the Image API prefix, and "/iiifx/" is not "/iiif/".
  assert.equal(planFor(new URL(`https://${HOST}/image/v3/x`), HOST).kind, "reject");
  assert.equal(planFor(new URL(`https://${HOST}/iiifx/y`), HOST).kind, "reject");
});

test("ungated oai URL → the external politeness bucket, no bearer", () => {
  const plan = sendPlan("https://oai.bnf.fr/oai2/OAIHandler?verb=GetRecord");
  assert.deepEqual(plan.acquire, ["external"]);
  assert.equal(plan.penalize, "external");
  assert.equal(plan.label, "external");
  assert.equal(plan.auth, false);
});

test("a manifest.json path on a NON-partner host is external, not a manifest", () => {
  // The manifest rule applies to the partner host only: a manifest-shaped
  // URL on an ungated host is politeness traffic.
  const plan = sendPlan("https://gallica.bnf.fr/iiif/presentation/v3/ark:/12148/x/manifest.json");
  assert.deepEqual(plan.acquire, ["external"]);
  assert.equal(plan.auth, false);
});
