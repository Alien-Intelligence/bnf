/**
 * The per-canvas IIIF image size (bnf/image-size.ts).
 *
 * BnF implements IIIF Image v3 strictly (live probe 2026-10-01,
 * prod-evidence/iiif-4096-probe*.txt): `full/!4096,4096` on a 6955×9894 master
 * returns 2879×4096, but on a 2592×3508 master it is a 400 (an upscale), and
 * `^!4096,4096` is refused. So the size is chosen per canvas from the dims the
 * manifest already carries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cachedImageCovers,
  iiifSizeFor,
  jpegDimensions,
  maxEdgeForLane,
  MISTRAL_MAX_EDGE_PX,
  VISION_MAX_EDGE_PX,
} from "./image-size.js";

/** A minimal structurally valid JPEG: SOI, an APP0 segment, a SOFn segment with
 *  the given dims, an SOS marker, a byte of scan data, EOI. */
function jpeg(width: number, height: number, sofMarker = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]); // length 4: two payload bytes
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xff00 | sofMarker, 0);
  sof.writeUInt16BE(17, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9); // components (3 × 3 bytes follow)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x00]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

test("the lane edges: 4096 px for Mistral (its limit), 2048 px for vision", () => {
  assert.equal(maxEdgeForLane("mistral"), MISTRAL_MAX_EDGE_PX);
  assert.equal(maxEdgeForLane("vision"), VISION_MAX_EDGE_PX);
  assert.equal(MISTRAL_MAX_EDGE_PX, 4096);
  assert.equal(VISION_MAX_EDGE_PX, 2048);
});

test("iiifSizeFor: a master above the edge on either axis is fitted into the box", () => {
  assert.equal(iiifSizeFor(4096, { width: 6955, height: 9894 }), "!4096,4096");
  assert.equal(iiifSizeFor(4096, { width: 4097, height: 10 }), "!4096,4096");
  assert.equal(iiifSizeFor(2048, { width: 6955, height: 9894 }), "!2048,2048");
});

test("iiifSizeFor: a master within the edge is fetched at max — a fit-in-box would upscale and BnF 400s it", () => {
  assert.equal(iiifSizeFor(4096, { width: 2592, height: 3508 }), "max");
  assert.equal(iiifSizeFor(4096, { width: 4096, height: 3000 }), "max", "exactly the edge is not above it");
  assert.equal(iiifSizeFor(2048, { width: 2048, height: 1500 }), "max");
});

test("iiifSizeFor: unknown or unusable dims → null (the caller decides and logs)", () => {
  assert.equal(iiifSizeFor(4096, undefined), null);
  assert.equal(iiifSizeFor(4096, { width: null, height: 9894 }), null);
  assert.equal(iiifSizeFor(4096, { width: 6955, height: null }), null);
  assert.equal(iiifSizeFor(4096, { width: 0, height: 100 }), null);
  assert.equal(iiifSizeFor(4096, { width: -5, height: 100 }), null);
});

test("jpegDimensions reads a baseline (SOF0) and a progressive (SOF2) frame header", () => {
  assert.deepEqual(jpegDimensions(jpeg(2879, 4096, 0xc0)), { width: 2879, height: 4096 });
  assert.deepEqual(jpegDimensions(jpeg(855, 1158, 0xc2)), { width: 855, height: 1158 });
});

test("jpegDimensions: no SOF before the scan, a DHT marker (0xC4) or a non-JPEG → null", () => {
  assert.equal(jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9])), null);
  const dht = jpeg(100, 100, 0xc4); // same layout, but C4 is a Huffman table, not a frame
  assert.equal(jpegDimensions(dht), null);
  assert.equal(jpegDimensions(Buffer.from("not a jpeg")), null);
  assert.equal(jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00])), null, "truncated SOF");
});

test("cachedImageCovers: a downscaled (pct:33) image does not serve the Mistral lane (F-D4)", () => {
  assert.equal(cachedImageCovers("mistral", jpeg(855, 1158), { width: 2592, height: 3508 }), false);
});

test("cachedImageCovers: a max-fetched image serves the Mistral lane, also when it is above 4096", () => {
  assert.equal(cachedImageCovers("mistral", jpeg(6955, 9894), { width: 6955, height: 9894 }), true);
  assert.equal(cachedImageCovers("mistral", jpeg(2592, 3508), { width: 2592, height: 3508 }), true);
  assert.equal(cachedImageCovers("mistral", jpeg(2879, 4096), { width: 6955, height: 9894 }), true, "a !4096,4096 fetch");
  assert.equal(cachedImageCovers("mistral", jpeg(2874, 4089), { width: 6955, height: 9894 }), true, "IIIF rounding tolerated");
});

test("cachedImageCovers: a Mistral cache entry whose frame cannot be read is not trusted", () => {
  const noSof = Buffer.from([0xff, 0xd8, 0x41, 0x42, 0xff, 0xd9]);
  assert.equal(cachedImageCovers("mistral", noSof, { width: 6955, height: 9894 }), false);
});

test("cachedImageCovers: vision reuses any complete image", () => {
  assert.equal(cachedImageCovers("vision", jpeg(855, 1158), { width: 6955, height: 9894 }), true);
  assert.equal(cachedImageCovers("vision", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), undefined), true);
});

test("cachedImageCovers: Mistral without canvas dims trusts only an image already at the 4096 cap", () => {
  // Without dims the master's size is unknown, so a small cached image may be
  // a downscale: it is re-fetched (at max). One at the cap is enough whatever
  // the master.
  assert.equal(cachedImageCovers("mistral", jpeg(855, 1158), undefined), false);
  assert.equal(cachedImageCovers("mistral", jpeg(2592, 3508), { width: null, height: null }), false);
  assert.equal(cachedImageCovers("mistral", jpeg(2879, 4096), undefined), true);
});
