/**
 * End-to-end tests of the broker's HTTP surface: `Retry-After` handling on
 * POST /fetch.
 *
 * server.ts configures itself from process.env and listens at import, so the
 * env is set BEFORE a dynamic import and the listener is closed in `after`.
 * Upstream BnF is replaced by an undici MockAgent (the broker's `fetch` comes
 * from the same undici instance, so it honours the global dispatcher); no
 * network is touched. The tests share one broker and run in order: the last
 * one freezes the `external` bucket, so it must stay last.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createProbe } from "node:net";
import type { Server } from "node:http";

import { MockAgent, setGlobalDispatcher } from "undici";

const UPSTREAM_ORIGIN = "https://gallica.bnf.fr";

let mock: MockAgent;
let server: Server;
let baseUrl: string;

/** A free TCP port: bind to 0, read the assignment, release it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createProbe();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("probe has no TCP address"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

before(async () => {
  const port = await freePort();
  const bucket = { rpm: 600, burst: 20 };
  const buckets = [
    "global",
    "manifest",
    "external",
    "presentation",
    "image",
    "iiifLegacy",
    "catalogue",
    "gallicaSru",
    "grapheData",
    "datePeriodique",
    "documentTdm",
  ];
  process.env.PORT = String(port);
  process.env.BNF_CLIENT_KEY = "test-key";
  process.env.BNF_CLIENT_SECRET = "test-secret";
  process.env.BNF_RATES = JSON.stringify(Object.fromEntries(buckets.map((b) => [b, bucket])));
  process.env.BNF_ACQUIRE_MAX_WAIT_MS = "50";

  mock = new MockAgent();
  mock.disableNetConnect();
  mock.enableNetConnect(/^127\.0\.0\.1(:\d+)?$/); // the test's own calls to the broker
  setGlobalDispatcher(mock);

  ({ server } = await import("./server.js"));
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await mock.close();
});

async function fetchViaBroker(path: string): Promise<Response> {
  return fetch(`${baseUrl}/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${UPSTREAM_ORIGIN}${path}` }),
  });
}

test("no Retry-After when the upstream sent none and nothing was shed", async () => {
  mock.get(UPSTREAM_ORIGIN).intercept({ path: "/ok", method: "GET" }).reply(200, "fine", { headers: { "content-type": "text/plain" } });

  const res = await fetchViaBroker("/ok");

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "fine");
  assert.equal(res.headers.get("retry-after"), null);
});

test("an upstream Retry-After is forwarded verbatim", async () => {
  mock
    .get(UPSTREAM_ORIGIN)
    .intercept({ path: "/busy", method: "GET" })
    .reply(503, "busy", { headers: { "content-type": "text/plain", "retry-after": "7" } });

  const res = await fetchViaBroker("/busy");

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "7");
});

test("a shed carries the bucket's refill time in whole seconds (>= 1)", async () => {
  // An upstream 429 freezes the `external` bucket for 120 s and is mirrored with its own header.
  mock
    .get(UPSTREAM_ORIGIN)
    .intercept({ path: "/throttled", method: "GET" })
    .reply(429, "slow down", { headers: { "content-type": "text/plain", "retry-after": "120" } });
  const upstream429 = await fetchViaBroker("/throttled");
  assert.equal(upstream429.status, 429);
  assert.equal(upstream429.headers.get("retry-after"), "120");

  // The freeze outlasts the 50 ms acquire budget, so the next request is shed
  // by the broker itself, with no upstream call (the mock has no interceptor).
  const shed = await fetchViaBroker("/next");

  assert.equal(shed.status, 429);
  assert.match(await shed.text(), /broker rate budget exhausted \(external\)/);
  const header = shed.headers.get("retry-after");
  assert.match(header ?? "", /^\d+$/, "whole seconds, not an HTTP-date or a fraction");
  const seconds = Number(header);
  assert.ok(seconds >= 119 && seconds <= 120, `expected ~120 s of freeze left, got ${seconds}`);
});
