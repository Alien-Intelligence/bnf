/**
 * CallLog (calls.ts) — the calls.csv the ramp test and the incident analyses
 * read. The new columns are appended, so every earlier column keeps its index.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CALLS_CSV_HEADER, CallLog, type CallRecord } from "./calls.js";

const BASE: CallRecord = {
  ts: Date.UTC(2026, 9, 5, 10, 0, 0),
  host: "openapiproext.bnf.fr",
  path: "/presentation/iiif/gallica/1.0.0/presentation/v3/ark:/12148/x/manifest.json",
  status: 200,
  bucket: "manifest",
  authed: true,
  waitMs: 12,
  fetchMs: 340,
  retryAfter: null,
  note: "ok",
  acquired: ["manifest", "presentation", "global"],
  shedBy: null,
};

test("the header keeps the eleven historical columns in place and ends with acquired,shed_by", () => {
  const cols = CALLS_CSV_HEADER.split(",");
  assert.deepEqual(cols.slice(0, 11), [
    "timestamp_iso", "epoch_ms", "host", "path", "status", "bucket",
    "authed", "wait_ms", "fetch_ms", "retry_after", "note",
  ]);
  assert.deepEqual(cols.slice(11), ["acquired", "shed_by"]);
});

test("a sent row serializes its plan; a shed row names the bucket that shed it", () => {
  const log = new CallLog(10);
  log.record(BASE);
  log.record({ ...BASE, status: 429, note: "shed", fetchMs: 0, shedBy: "presentation" });
  const [header, sent, shed] = log.toCsv().trimEnd().split("\n");
  assert.equal(header, CALLS_CSV_HEADER);
  assert.deepEqual(sent?.split(",").slice(-2), ["manifest+presentation+global", ""]);
  assert.deepEqual(shed?.split(",").slice(4, 6), ["429", "manifest"]);
  assert.deepEqual(shed?.split(",").slice(-3), ["shed", "manifest+presentation+global", "presentation"]);
});

test("an unclassified reject has no bucket and acquired nothing", () => {
  const log = new CallLog(10);
  log.record({ ...BASE, path: "/foo/bar", status: 403, bucket: null, authed: false, note: "unclassified", acquired: [] });
  const row = log.toCsv().trimEnd().split("\n")[1]?.split(",");
  assert.equal(row?.[5], "", "bucket column empty");
  assert.deepEqual(row?.slice(-3), ["unclassified", "", ""]);
});

test("the ring keeps the newest rows, oldest first; capacity 0 records nothing; reset empties it", () => {
  const log = new CallLog(2);
  for (const status of [201, 202, 203]) log.record({ ...BASE, status });
  const statuses = log.toCsv().trimEnd().split("\n").slice(1).map((l) => l.split(",")[4]);
  assert.deepEqual(statuses, ["202", "203"]);
  log.reset();
  assert.equal(log.size(), 0);
  const off = new CallLog(0);
  off.record(BASE);
  assert.equal(off.size(), 0);
  assert.equal(off.toCsv(), `${CALLS_CSV_HEADER}\n`);
});
