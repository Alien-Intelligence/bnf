/**
 * truncatedBodyError — the 2026-08-13 truncation guard. A silent body prefix
 * (chunked upstream + clean close) must read as a transport failure when the
 * upstream declared its length; absent/junk declarations verify nothing, and an
 * ENCODED body verifies nothing either (the declared length counts wire bytes,
 * the buffer holds decoded ones).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { truncatedBodyError } from "./body.js";

test("matching declared length passes", () => {
  assert.equal(truncatedBodyError(1024, "1024", null), null);
});

test("short body vs declared length is a truncation error", () => {
  const err = truncatedBodyError(512, "1024", null);
  assert.ok(err && err.includes("got 512 of 1024"));
});

test("over-long body vs declared length is also an error (never mirror it)", () => {
  assert.ok(truncatedBodyError(2048, "1024", null));
});

test("no content-length header verifies nothing", () => {
  assert.equal(truncatedBodyError(512, null, null), null);
});

test("junk content-length header verifies nothing", () => {
  assert.equal(truncatedBodyError(512, "banana", null), null);
  assert.equal(truncatedBodyError(512, "-5", null), null);
});

test("zero-length body with declared 0 passes", () => {
  assert.equal(truncatedBodyError(0, "0", null), null);
});

// --- encoded bodies: the 2026-09-18 false-positive -------------------------
// The exact numbers oai.bnf.fr returns: gzip, 1341 declared wire bytes, 3800
// decoded. Before this guard understood content-encoding, that read as a
// truncation and 502'd the whole OAI metadata lane.

test("gzip body is not truncated even though the lengths differ", () => {
  assert.equal(truncatedBodyError(3800, "1341", "gzip"), null);
});

test("br and deflate are treated the same as gzip", () => {
  assert.equal(truncatedBodyError(3800, "1341", "br"), null);
  assert.equal(truncatedBodyError(3800, "1341", "deflate"), null);
});

test("content-encoding is matched case-insensitively and trimmed", () => {
  assert.equal(truncatedBodyError(3800, "1341", " GZIP "), null);
});

test("a chain of encodings still means the length is unverifiable", () => {
  assert.equal(truncatedBodyError(3800, "1341", "gzip, br"), null);
});

test("identity is NOT an encoding — the guard still applies", () => {
  assert.ok(truncatedBodyError(512, "1024", "identity"));
  assert.equal(truncatedBodyError(1024, "1024", "identity"), null);
});

test("an empty content-encoding header leaves the guard active", () => {
  assert.ok(truncatedBodyError(512, "1024", ""));
});

test("a truncated gzip body cannot be caught here (the second belt owns it)", () => {
  // Documenting the accepted trade-off: with an encoded body there is nothing
  // to compare, so a genuine prefix passes this layer. The worker's content
  // validation (JPEG EOI, XML parse) is what catches it. Images and ALTO from
  // the BnF gateway are served identity, so the original incident's path keeps
  // its guard.
  assert.equal(truncatedBodyError(12, "1341", "gzip"), null);
});
