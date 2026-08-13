/**
 * LiveBnfClient timeout-wiring test (F4, ai-memories/tech/repos/bnf/ingest-hardening).
 *
 * Every broker-bound IIIF call (manifest, ALTO, image) must run on the LONG
 * PAGE_TIMEOUT_MS budget (135s default) — deliberately LARGER than the broker's
 * own 120s upstream timeout, so the broker's own clean, classifiable timeout wins
 * instead of the worker aborting the broker mid-flight. Before this fix,
 * getManifest ran on the SHORT DEFAULT_TIMEOUT_MS (45s default — sized for the
 * fast, ungated OAI-PMH call only): under load the worker's abort usually fired
 * before the broker's, producing an opaque "operation was aborted" instead of a
 * clean, retryable timeout.
 *
 * This drives a REAL LiveBnfClient against a local fake "broker" HTTP server that
 * delays every response by a fixed amount — long enough to outlast a SHORT
 * timeout budget but not a LONG one — and asserts getManifest survives that delay
 * while getDocumentInfoViaOai (which legitimately keeps the short budget: OAI is
 * fast and ungated, F4 never touched it) does not.
 *
 * DEFAULT_TIMEOUT_MS / PAGE_TIMEOUT_MS are read from env at client.ts's MODULE
 * LOAD time, so the env vars below are set before the dynamic import — a static
 * `import` at the top of this file would already have captured the process
 * defaults (45_000 / 135_000) before this code ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const SHORT_BUDGET_MS = "50"; // stands in for DEFAULT_TIMEOUT_MS (OAI)
const LONG_BUDGET_MS = "300"; // stands in for PAGE_TIMEOUT_MS (manifest/folio)
const FAKE_BROKER_DELAY_MS = 150; // between the two — the whole point of the test

process.env.BNF_META_TIMEOUT_MS = SHORT_BUDGET_MS;
process.env.BNF_PAGE_TIMEOUT_MS = LONG_BUDGET_MS;

const { LiveBnfClient } = await import("./client.js");

/** A fake broker (POST /fetch) that waits `delayMs` then returns an empty JSON
 *  body — good enough for getManifest's parser (parseV3Manifest tolerates a
 *  field-less object) and irrelevant to getDocumentInfoViaOai, which is meant to
 *  time out before the body ever arrives. */
function startFakeBroker(delayMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      req.on("data", () => {}); // drain the request body
      req.on("end", () => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }, delayMs);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("getManifest survives a delay that would trip the SHORT (OAI) budget — it runs on PAGE_TIMEOUT_MS", async () => {
  const broker = await startFakeBroker(FAKE_BROKER_DELAY_MS);
  process.env.BNF_BROKER_URL = broker.url;
  try {
    const client = new LiveBnfClient();
    const manifest = await client.getManifest("ark:/12148/timeouttest", 5);
    assert.ok(
      manifest,
      `resolved despite a ${FAKE_BROKER_DELAY_MS}ms delay against a ${SHORT_BUDGET_MS}ms short budget — ` +
        "proves getManifest is NOT on the short budget",
    );
  } finally {
    await broker.close();
  }
});

test("getDocumentInfoViaOai keeps the SHORT budget — the F4 fix is scoped to the manifest path only", async () => {
  const broker = await startFakeBroker(FAKE_BROKER_DELAY_MS);
  process.env.BNF_BROKER_URL = broker.url;
  try {
    const client = new LiveBnfClient();
    await assert.rejects(
      client.getDocumentInfoViaOai("ark:/12148/timeouttest"),
      (err: unknown) => err instanceof Error && /network/i.test(err.message),
      `should abort at ~${SHORT_BUDGET_MS}ms against the ${FAKE_BROKER_DELAY_MS}ms delay — ` +
        "if this ever resolves, OAI accidentally inherited the long budget",
    );
  } finally {
    await broker.close();
  }
});
