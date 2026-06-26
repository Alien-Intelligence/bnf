/**
 * Unit tests for the in-memory blob store (core/blob.ts).
 *
 * Scope: MemoryBlobStore only. S3BlobStore needs real S3 — it gets a single
 * construct-only smoke (with fake creds) and nothing more.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemoryBlobStore, S3BlobStore } from "./blob.js";

describe("MemoryBlobStore", () => {
  it("has() is false for a missing key, true after a put", async () => {
    const blob = new MemoryBlobStore();
    assert.equal(await blob.has("k"), false);
    await blob.putJson("k", { a: 1 });
    assert.equal(await blob.has("k"), true);
  });

  it("putJson/getJson round-trips an object; getJson returns null for missing", async () => {
    const blob = new MemoryBlobStore();
    const value = { ark: "ark:/12148/abc", folios: [1, 2, 3], nested: { ok: true } };

    await blob.putJson("manifest", value);
    const got = await blob.getJson<typeof value>("manifest");
    assert.deepEqual(got, value);

    assert.equal(await blob.getJson("absent"), null);
  });

  it("putBytes/getBytes round-trips a Buffer exactly; getBytes returns null for missing", async () => {
    const blob = new MemoryBlobStore();
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80]);

    await blob.putBytes("alto", bytes);
    const got = await blob.getBytes("alto");
    assert.ok(got !== null);
    assert.ok(Buffer.isBuffer(got));
    assert.equal(Buffer.compare(got, bytes), 0);

    assert.equal(await blob.getBytes("absent"), null);
  });

  describe("JSON and bytes share one keyspace", () => {
    // Documented behaviour: MemoryBlobStore stores everything as a Buffer.
    // putJson stores Buffer.from(JSON.stringify(value)); getBytes returns that
    // raw buffer; getJson JSON.parses whatever bytes are present.

    it("a key put as JSON is retrievable as bytes = the UTF-8 of the JSON", async () => {
      const blob = new MemoryBlobStore();
      const value = { a: 1, b: "x" };

      await blob.putJson("shared", value);

      const asBytes = await blob.getBytes("shared");
      assert.ok(asBytes !== null);
      assert.equal(asBytes.toString("utf8"), JSON.stringify(value));
    });

    it("a key put as JSON-shaped bytes is retrievable as JSON (vice-versa)", async () => {
      const blob = new MemoryBlobStore();
      const value = { a: 1, b: "x" };
      const bytes = Buffer.from(JSON.stringify(value), "utf8");

      await blob.putBytes("shared", bytes);

      const asJson = await blob.getJson<typeof value>("shared");
      assert.deepEqual(asJson, value);
    });

    it("getJson over non-JSON bytes throws (no swallowing) — documents the trap", async () => {
      const blob = new MemoryBlobStore();
      await blob.putBytes("raw", Buffer.from([0x00, 0x01, 0xff]));

      // JSON.parse of arbitrary bytes is not caught — surfaces as a throw.
      await assert.rejects(() => blob.getJson("raw"), SyntaxError);
    });
  });

  it("overwriting a key replaces the value", async () => {
    const blob = new MemoryBlobStore();

    await blob.putJson("k", { v: 1 });
    assert.deepEqual(await blob.getJson("k"), { v: 1 });

    await blob.putJson("k", { v: 2 });
    assert.deepEqual(await blob.getJson("k"), { v: 2 });

    // overwrite across the shared keyspace too: JSON -> bytes
    await blob.putBytes("k", Buffer.from("plain", "utf8"));
    const asBytes = await blob.getBytes("k");
    assert.ok(asBytes !== null);
    assert.equal(asBytes.toString("utf8"), "plain");

    // still one key
    assert.equal(blob.size(), 1);
  });

  it("size() reflects the number of distinct keys", async () => {
    const blob = new MemoryBlobStore();
    assert.equal(blob.size(), 0);

    await blob.putJson("a", { n: 1 });
    assert.equal(blob.size(), 1);

    await blob.putBytes("b", Buffer.from("b"));
    assert.equal(blob.size(), 2);

    // re-putting an existing key does not grow the keyspace
    await blob.putJson("a", { n: 99 });
    assert.equal(blob.size(), 2);
  });
});

describe("S3BlobStore", () => {
  it("constructs with fake credentials without throwing (no network)", () => {
    assert.doesNotThrow(() => {
      new S3BlobStore({
        bucket: "fake-bucket",
        endpoint: "https://s3.fake.example",
        region: "fr-par",
        accessKeyId: "AKIAFAKE",
        secretAccessKey: "fakeSecret",
        prefix: "proj-1/",
      });
    });
  });
});
