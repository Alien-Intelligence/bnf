/**
 * The IIIF image size an image folio is fetched at, chosen PER CANVAS.
 *
 * BnF implements IIIF Image v3 strictly: any size that would UPSCALE is a 400,
 * and `^` (upscale allowed) is refused. It checks each axis of a fit-in-box
 * `!w,h` on its own, so `!4096,4096` is a 400 for a 3812×5387 master ("w must
 * not be greater than the width of the extracted region") even though the fit
 * itself would downscale. So the size names the long edge alone: `,h` for a
 * portrait master, `w,` for a landscape one, and BnF keeps the aspect ratio
 * (6955×9894 at `,4096` → 2879×4096). The manifest's canvas `width`/`height`
 * (already parsed and cached, no `info.json` call) decide: `max` when the
 * master fits within the lane's edge, else the long edge scaled to it.
 *
 * Pure: no I/O. stages/fetch.ts applies it.
 */
import type { Lane } from "../domain/queues.js";

/** Mistral OCR rejects images above 4096 px (BnF DSI, 2026-09-25). */
export const MISTRAL_MAX_EDGE_PX = 4096;
/**
 * Vision describes, it does not transcribe: a fixed cap bounds the bytes and
 * the model tiles per call (Gemini tiles at 768 px: 2048 px ≈ 6 tiles, against
 * ≈ 15 for the old `pct:33` of a newspaper master) and keeps small masters
 * legible, where `pct:33` shrank a 2592×3508 master to 855×1158.
 */
export const VISION_MAX_EDGE_PX = 2048;
/** IIIF rounding tolerance when checking that a cached image reaches its target edge. */
export const CACHED_EDGE_TOLERANCE = 0.98;

/** The lanes that fetch images. */
export type ImageLane = Extract<Lane, "mistral" | "vision">;

/** A canvas's pixel dims as the manifest declares them (null when it does not). */
export interface CanvasDims {
  width: number | null;
  height: number | null;
}

/** The longest edge an image of `lane` is fetched at. */
export function maxEdgeForLane(lane: ImageLane): number {
  return lane === "mistral" ? MISTRAL_MAX_EDGE_PX : VISION_MAX_EDGE_PX;
}

/** The canvas's dims when both are positive finite numbers, else null. */
function usableDims(dims: CanvasDims | undefined): { width: number; height: number } | null {
  if (!dims) return null;
  const { width, height } = dims;
  if (width === null || height === null) return null;
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null;
  return { width, height };
}

/** The canvas's long edge, or null when a dim is missing or not a positive number. */
function canvasLongEdge(dims: CanvasDims | undefined): number | null {
  const usable = usableDims(dims);
  return usable === null ? null : Math.max(usable.width, usable.height);
}

/**
 * The IIIF `size` segment for a canvas: `max` when its long edge is within
 * `maxEdge`, else that long edge scaled to `maxEdge` (`w,` landscape or square,
 * `,h` portrait). Null when the dims are unknown: the caller decides (and logs)
 * what to do then.
 */
export function iiifSizeFor(maxEdge: number, dims: CanvasDims | undefined): string | null {
  const usable = usableDims(dims);
  if (usable === null) return null;
  const { width, height } = usable;
  if (Math.max(width, height) <= maxEdge) return "max";
  return width >= height ? `${maxEdge},` : `,${maxEdge}`;
}

/** Start-of-frame markers SOF0–SOF15, minus the three in that range that are not frames. */
const NOT_A_FRAME = new Set([0xc4 /* DHT */, 0xc8 /* JPG */, 0xcc /* DAC */]);
/** Markers that stand alone (no length field): TEM, RST0–7, SOI, EOI. */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/**
 * The pixel dims a JPEG declares in its frame header (SOFn), or null when no
 * frame header precedes the scan (or the bytes are not a JPEG / are cut short).
 * Walks the marker segments from SOI; never reads the entropy-coded data.
 */
export function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    // Fill bytes: any number of 0xFF may precede a marker.
    let m = i + 1;
    while (m < bytes.length && bytes[m] === 0xff) m++;
    const marker = bytes[m];
    if (marker === undefined) return null;
    if (isStandalone(marker)) {
      i = m + 1;
      continue;
    }
    if (marker === 0xda) return null; // start of scan: no frame header came first
    if (m + 2 >= bytes.length) return null;
    const length = bytes.readUInt16BE(m + 1);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && !NOT_A_FRAME.has(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (m + 7 >= bytes.length) return null;
      return { height: bytes.readUInt16BE(m + 4), width: bytes.readUInt16BE(m + 6) };
    }
    i = m + 1 + length;
  }
  return null;
}

/**
 * Does a complete cached image serve `lane`? (F-D4: the cache key is the same
 * for every size, so a vision downscale must never stand in for an OCR image.)
 *
 * - vision: any complete image — a description does not need more pixels.
 * - mistral: its long edge must reach (within IIIF rounding) what this lane
 *   would fetch now: `min(4096, canvas long edge)`, or the full 4096 when the
 *   canvas dims are unknown (the master could be anything). An image whose
 *   frame header cannot be read is not trusted. Every image ever fetched at
 *   `max` passes, so the existing cache stays in use.
 */
export function cachedImageCovers(lane: ImageLane, cached: Buffer, dims: CanvasDims | undefined): boolean {
  if (lane === "vision") return true;
  const got = jpegDimensions(cached);
  if (got === null) return false;
  const canvas = canvasLongEdge(dims);
  const target = canvas === null ? MISTRAL_MAX_EDGE_PX : Math.min(MISTRAL_MAX_EDGE_PX, canvas);
  return Math.max(got.width, got.height) >= CACHED_EDGE_TOLERANCE * target;
}
