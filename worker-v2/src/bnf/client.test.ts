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

import { TransientBnfError } from "./errors.js";

const SHORT_BUDGET_MS = "50"; // stands in for DEFAULT_TIMEOUT_MS (OAI)
const LONG_BUDGET_MS = "300"; // stands in for PAGE_TIMEOUT_MS (manifest/folio)
const FAKE_BROKER_DELAY_MS = 150; // between the two — the whole point of the test

process.env.BNF_META_TIMEOUT_MS = SHORT_BUDGET_MS;
process.env.BNF_PAGE_TIMEOUT_MS = LONG_BUDGET_MS;

const { LiveBnfClient, docInfoFromManifest, decodeBnfBytes } = await import("./client.js");
const { createMemoryLogger } = await import("../core/logger.js");

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

// ---------------------------------------------------------------------------
// docInfoFromManifest — "Taux OCR" is kept as a number, not reduced to a boolean
// ---------------------------------------------------------------------------

const ARK = "ark:/12148/bpt6k4625753w";

function manifestWith(metadata: Array<{ label: string; value: string }>) {
  return { title: "L'Auto-vélo", metadata, totalPages: 8, canvases: [] };
}

test("docInfoFromManifest: a Taux OCR row yields ocrRate as a fraction AND ocrAvailable true", () => {
  const info = docInfoFromManifest(
    manifestWith([
      { label: "Titre", value: "L'Auto-vélo" },
      { label: "Taux OCR", value: "78.21 %" },
    ]),
    ARK,
  );
  assert.equal(info.ocrRate, 0.7821);
  assert.equal(info.ocrAvailable, true);
});

test("docInfoFromManifest: no Taux OCR row → ocrRate null, ocrAvailable false", () => {
  const info = docInfoFromManifest(
    manifestWith([
      { label: "Titre", value: "Carte de Paris" },
      { label: "Type document", value: "Carte" },
    ]),
    ARK,
  );
  assert.equal(info.ocrRate, null);
  assert.equal(info.ocrAvailable, false);
});

test("docInfoFromManifest: a Taux OCR row with an unparsable value keeps ocrAvailable true (the label is present) but ocrRate null", () => {
  const info = docInfoFromManifest(
    manifestWith([
      { label: "Titre", value: "Un titre" },
      { label: "Taux OCR", value: "n/a" },
    ]),
    ARK,
  );
  assert.equal(info.ocrAvailable, true, "lane routing semantics are unchanged: the label is present");
  assert.equal(info.ocrRate, null);
});

// ---------------------------------------------------------------------------
// fetchAltoFolio — what a 200 / 404 from the broker becomes
// ---------------------------------------------------------------------------

/** A fake broker answering every fetch with a fixed upstream status + body. */
function startStaticBroker(
  status: number,
  body: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/xml; charset=utf-8" });
        res.end(body);
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

async function fetchAltoVia(status: number, body: string) {
  const broker = await startStaticBroker(status, body);
  process.env.BNF_BROKER_URL = broker.url;
  try {
    return await new LiveBnfClient().fetchAltoFolio(ARK, 1);
  } finally {
    await broker.close();
  }
}

test("fetchAltoFolio: a 404 is a legitimately text-less folio", async () => {
  const folio = await fetchAltoVia(404, "not found");
  assert.equal(folio.empty, true);
  assert.deepEqual(folio.quality, { v: 1, wordCount: 0, scoredWordCount: 0, meanWc: null });
});

test("fetchAltoFolio: a 200 with an empty or blank body is TRANSIENT, never cached as a blank page", async () => {
  for (const body of ["", "   \n  "]) {
    await assert.rejects(
      () => fetchAltoVia(200, body),
      (err: unknown) => err instanceof TransientBnfError && err.cause === "alto_empty_body",
    );
  }
});

test("fetchAltoFolio: a 200 HTML error page is a transient parse failure", async () => {
  await assert.rejects(
    () => fetchAltoVia(200, "<html><body>Service Unavailable</body></html>"),
    (err: unknown) => err instanceof TransientBnfError && err.cause === "alto_parse_failed",
  );
});

test("fetchAltoFolio: a valid 200 ALTO maps text and word confidence", async () => {
  const folio = await fetchAltoVia(
    200,
    `<alto><Layout><Page><PrintSpace><TextBlock><TextLine><String CONTENT="Le" WC="1"/><String CONTENT="vélo" WC="0.5"/></TextLine></TextBlock></PrintSpace></Page></Layout></alto>`,
  );
  assert.equal(folio.text, "Le vélo");
  assert.equal(folio.empty, false);
  assert.deepEqual(folio.quality, { v: 1, wordCount: 2, scoredWordCount: 2, meanWc: 0.75 });
});

// ---------------------------------------------------------------------------
// decodeBnfBytes — an unknown declared charset is logged, not silently ignored
// ---------------------------------------------------------------------------

test("decodeBnfBytes: an unknown declared charset falls back to UTF-8 AND logs it", () => {
  const { logger, lines } = createMemoryLogger();
  const text = decodeBnfBytes(Buffer.from("abc", "utf8"), "text/xml; charset=x-bogus-9", logger);
  assert.equal(text, "abc");
  const line = lines.find((l) => l.event === "bnf_unknown_charset");
  assert.ok(line, "the fallback is logged");
  assert.equal(line.charset, "x-bogus-9");
});

test("decodeBnfBytes: a known charset decodes without a log line", () => {
  const { logger, lines } = createMemoryLogger();
  assert.equal(decodeBnfBytes(Buffer.from([0xe9]), "text/xml; charset=iso-8859-1", logger), "é");
  assert.equal(lines.length, 0);
});

