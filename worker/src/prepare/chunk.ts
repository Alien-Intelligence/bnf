/**
 * Markdown chunker for prepared BnF docs.
 *
 * Goals:
 *   - target ~TARGET_SIZE chars, with OVERLAP chars between consecutive chunks
 *   - never split inside a triple-backtick fenced code block
 *   - prefer breaking at `\n## ` or `\n### ` heading boundaries within ±TOLERANCE
 *     of the target size
 *   - NEVER let a chunk span a `## Folio N` boundary: the markdown is split into
 *     per-folio segments first, then each segment is size-chunked independently
 *     and every chunk is stamped with that segment's folio. This guarantees one
 *     folio per chunk — a passage's cited folio is then always the page the text
 *     physically sits on. (A chunk stamped with its START folio while spilling
 *     into the next page was the source of off-by-one citations.)
 *
 * Output: ChunkRow[] (chunkIndex, text, charStart, charEnd, metadata).
 * `text` is the raw substring of the source markdown — we deliberately don't
 * normalize whitespace beyond trimming because charStart/charEnd refer to the
 * original body, and downstream tooling may want to highlight the source.
 */
import type { ChunkRow } from "../types.js";

export interface ChunkOptions {
  /** Target chunk size in characters. */
  targetSize?: number;
  /** Overlap between consecutive chunks. */
  overlap?: number;
  /** How far from `targetSize` we'll search for a heading boundary. */
  tolerance?: number;
  /** Carried into every chunk's metadata. */
  baseMetadata: {
    ark: string;
    arkSlug: string;
    docType?: string;
    subtype?: string;
  } & Record<string, unknown>;
  /**
   * Per-folio metadata merged into the chunk metadata when the chunk falls
   * under a `## Folio N` heading. Used by the multi-canvas image path to
   * stamp each chunk with its canvas's `iiif_url`.
   */
  folioMetadata?: Map<number, Record<string, unknown>>;
}

const TARGET_SIZE = 1024;
const OVERLAP = 128;
const TOLERANCE = 200;

/** Parses `## Folio N` (with optional trailing text after N). */
const FOLIO_HEADING_RE = /^##\s+Folio\s+(\d+)\b/m;

interface FolioMarker {
  /** Offset in source where the folio section begins (start of the heading). */
  start: number;
  folio: number;
}

/** Scan the markdown for every `## Folio N` and return ordered markers. */
function scanFolios(markdown: string): FolioMarker[] {
  const out: FolioMarker[] = [];
  const re = /(^|\n)##\s+Folio\s+(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const headingStart = m.index + (m[1] === "" ? 0 : 1);
    const folio = Number.parseInt(m[2]!, 10);
    if (Number.isFinite(folio)) {
      out.push({ start: headingStart, folio });
    }
  }
  return out;
}

/** A contiguous run of markdown that belongs to exactly one folio (or none). */
interface FolioSegment {
  start: number;
  end: number;
  /** Undefined for the document header that precedes the first `## Folio N`. */
  folio: number | undefined;
}

/**
 * Partition the markdown into folio segments. The header before the first
 * `## Folio N` (title/metadata block) becomes a folio-less segment; each folio
 * heading opens a segment that runs until the next heading (or EOF).
 */
function buildFolioSegments(markdown: string, markers: FolioMarker[]): FolioSegment[] {
  const len = markdown.length;
  if (markers.length === 0) return [{ start: 0, end: len, folio: undefined }];

  const segments: FolioSegment[] = [];
  if (markers[0]!.start > 0) {
    segments.push({ start: 0, end: markers[0]!.start, folio: undefined });
  }
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i]!.start;
    const end = i + 1 < markers.length ? markers[i + 1]!.start : len;
    segments.push({ start, end, folio: markers[i]!.folio });
  }
  return segments;
}

/**
 * Build a set of offsets where it is UNSAFE to split (inside a fenced code
 * block). We mark every char index that falls strictly between the opening
 * fence's terminating newline and the closing fence's first char.
 */
function buildCodeFenceMask(markdown: string): (offset: number) => boolean {
  // Find all triple-backtick fences at line start.
  const ranges: Array<[number, number]> = [];
  const re = /(^|\n)```[^\n]*\n/g;
  let m: RegExpExecArray | null;
  let inside = false;
  let openStart = 0;
  while ((m = re.exec(markdown)) !== null) {
    const fenceStart = m.index + (m[1] === "" ? 0 : 1);
    if (!inside) {
      openStart = fenceStart;
      inside = true;
    } else {
      // closing fence — range is [openStart, end of this fence line]
      const closeEnd = re.lastIndex;
      ranges.push([openStart, closeEnd]);
      inside = false;
    }
  }
  // If a fence was opened but never closed, lock from openStart to EOF.
  if (inside) ranges.push([openStart, markdown.length]);

  return (offset: number): boolean => {
    for (const [a, b] of ranges) {
      if (offset > a && offset < b) return true;
      if (offset < a) return false; // ranges are ordered
    }
    return false;
  };
}

/**
 * Find the best split offset near `idealEnd` within a code-fence-safe window,
 * preferring `\n## ` / `\n### ` heading boundaries. `limit` is the hard upper
 * bound (the folio segment's end) past which we must never cut. Returns an
 * offset in (start, limit]; never returns <= start.
 */
function findBreakOffset(
  markdown: string,
  start: number,
  idealEnd: number,
  limit: number,
  isInsideCodeFence: (o: number) => boolean,
): number {
  if (idealEnd >= limit) return limit;

  const lo = Math.max(start + 1, idealEnd - TOLERANCE);
  const hi = Math.min(limit, idealEnd + TOLERANCE);

  // 1) Look for a heading boundary within [lo, hi], pick the one closest to idealEnd.
  let bestHeading: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  const headingRe = /\n(##|###)\s/g;
  headingRe.lastIndex = lo;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(markdown)) !== null) {
    if (m.index >= hi) break;
    // We want to split at the '\n' BEFORE the heading so the heading starts the next chunk.
    const cut = m.index;
    if (cut <= start) continue;
    if (isInsideCodeFence(cut)) continue;
    const d = Math.abs(cut - idealEnd);
    if (d < bestDist) {
      bestDist = d;
      bestHeading = cut;
    }
  }
  if (bestHeading !== null) return bestHeading;

  // 2) Fall back to a paragraph break (blank line) within tolerance.
  let bestPara: number | null = null;
  bestDist = Number.POSITIVE_INFINITY;
  const paraRe = /\n\n/g;
  paraRe.lastIndex = lo;
  while ((m = paraRe.exec(markdown)) !== null) {
    if (m.index >= hi) break;
    const cut = m.index;
    if (cut <= start) continue;
    if (isInsideCodeFence(cut)) continue;
    const d = Math.abs(cut - idealEnd);
    if (d < bestDist) {
      bestDist = d;
      bestPara = cut;
    }
  }
  if (bestPara !== null) return bestPara;

  // 3) Fall back to the next safe single newline at or after idealEnd (within the segment).
  for (let i = idealEnd; i < limit; i++) {
    if (markdown.charCodeAt(i) === 10 /* \n */ && !isInsideCodeFence(i)) return i;
  }

  // 4) Last resort: hard cut at the segment end (don't split mid-code-fence; the
  //    fence extends to the segment end in that pathological case, so we just
  //    emit the whole tail as one chunk).
  return limit;
}

export function chunkMarkdown(markdown: string, opts: ChunkOptions): ChunkRow[] {
  const targetSize = opts.targetSize ?? TARGET_SIZE;
  const overlap = opts.overlap ?? OVERLAP;
  const folios = scanFolios(markdown);
  const isInsideCodeFence = buildCodeFenceMask(markdown);

  const rows: ChunkRow[] = [];
  if (markdown.length === 0) return rows;

  // Chunk each folio segment independently. A chunk therefore never crosses a
  // `## Folio N` boundary, and the folio stamped on it is the page the text
  // actually sits on — overlap stays inside a folio and never bleeds across.
  let chunkIndex = 0;
  for (const seg of buildFolioSegments(markdown, folios)) {
    chunkIndex = chunkSegment(markdown, seg, opts, targetSize, overlap, isInsideCodeFence, chunkIndex, rows);
  }

  return rows;
}

/**
 * Size-chunk a single folio segment in place, appending to `rows`. Offsets in
 * the emitted ChunkRows stay absolute (into the original markdown), so the
 * stored doc.md and char_start/char_end remain consistent. Returns the next
 * chunk index.
 */
function chunkSegment(
  markdown: string,
  seg: FolioSegment,
  opts: ChunkOptions,
  targetSize: number,
  overlap: number,
  isInsideCodeFence: (o: number) => boolean,
  startIndex: number,
  rows: ChunkRow[],
): number {
  let start = seg.start;
  let chunkIndex = startIndex;
  let guard = 0;
  const segLen = seg.end - seg.start;
  const guardMax = Math.ceil((segLen / Math.max(1, targetSize - overlap)) * 4) + 16;

  while (start < seg.end) {
    if (++guard > guardMax) {
      throw new Error(
        `chunkSegment: split loop failed to make progress at start=${start} (folio=${seg.folio})`,
      );
    }

    const idealEnd = Math.min(seg.end, start + targetSize);
    let end: number;
    if (idealEnd >= seg.end) {
      end = seg.end;
    } else {
      end = findBreakOffset(markdown, start, idealEnd, seg.end, isInsideCodeFence);
      // Ensure progress: at minimum, advance to idealEnd (capped at the segment).
      if (end <= start) end = Math.min(seg.end, start + targetSize);
    }

    const text = markdown.slice(start, end).trim();
    if (text.length > 0) {
      const metadata: ChunkRow["metadata"] = {
        ...opts.baseMetadata,
        ark: opts.baseMetadata.ark,
        arkSlug: opts.baseMetadata.arkSlug,
      };
      if (opts.baseMetadata.docType !== undefined) {
        metadata.docType = opts.baseMetadata.docType;
      }
      if (opts.baseMetadata.subtype !== undefined) {
        metadata.subtype = opts.baseMetadata.subtype;
      }
      if (seg.folio !== undefined) {
        metadata.folio = seg.folio;
        const perFolio = opts.folioMetadata?.get(seg.folio);
        if (perFolio) Object.assign(metadata, perFolio);
      }

      rows.push({
        chunkIndex: chunkIndex++,
        text,
        charStart: start,
        charEnd: end,
        metadata,
      });
    }

    if (end >= seg.end) break;
    // Step forward by (chunk size - overlap), but never go backwards or stall.
    const step = Math.max(1, end - start - overlap);
    start = start + step;
  }

  return chunkIndex;
}
