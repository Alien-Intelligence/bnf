/**
 * truncatedBodyError — the 2026-08-13 truncation guard. A silent body prefix
 * (chunked upstream + clean close) must read as a transport failure when the
 * upstream declared its length; absent/junk declarations verify nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { truncatedBodyError } from "./body.js";

test("matching declared length passes", () => {
  assert.equal(truncatedBodyError(1024, "1024"), null);
});

test("short body vs declared length is a truncation error", () => {
  const err = truncatedBodyError(512, "1024");
  assert.ok(err && err.includes("got 512 of 1024"));
});

test("over-long body vs declared length is also an error (never mirror it)", () => {
  assert.ok(truncatedBodyError(2048, "1024"));
});

test("no content-length header verifies nothing", () => {
  assert.equal(truncatedBodyError(512, null), null);
});

test("junk content-length header verifies nothing", () => {
  assert.equal(truncatedBodyError(512, "banana"), null);
  assert.equal(truncatedBodyError(512, "-5"), null);
});

test("zero-length body with declared 0 passes", () => {
  assert.equal(truncatedBodyError(0, "0"), null);
});
