/**
 * Markdown chunker for prepared BnF docs.
 *
 * Goals:
 *   - target ~TARGET_SIZE chars, with OVERLAP chars between consecutive chunks
 *   - never split inside a triple-backtick fenced code block
 *   - prefer breaking at `\n## ` or `\n### ` heading boundaries within ±TOLERANCE
 *     of the target size
 *   - track `## Folio N` headings and stamp `folio: N` on every chunk whose
 *     start offset lies within that folio's section
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

/** Folio in effect at `offset`, or undefined if none. */
function folioAt(markers: FolioMarker[], offset: number): number | undefined {
  let current: number | undefined;
  for (const m of markers) {
    if (m.start <= offset) current = m.folio;
    else break;
  }
  return current;
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
 * preferring `\n## ` / `\n### ` heading boundaries. Returns an offset in
 * (start, markdown.length]; never returns <= start.
 */
function findBreakOffset(
  markdown: string,
  start: number,
  idealEnd: number,
  isInsideCodeFence: (o: number) => boolean,
): number {
  const len = markdown.length;
  if (idealEnd >= len) return len;

  const lo = Math.max(start + 1, idealEnd - TOLERANCE);
  const hi = Math.min(len, idealEnd + TOLERANCE);

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

  // 3) Fall back to the next safe single newline at or after idealEnd.
  for (let i = idealEnd; i < len; i++) {
    if (markdown.charCodeAt(i) === 10 /* \n */ && !isInsideCodeFence(i)) return i;
  }

  // 4) Last resort: hard cut at the end (don't split mid-code-fence; the fence
  //    extends to EOF in that pathological case, so we just emit the whole tail
  //    as one chunk).
  return len;
}

export function chunkMarkdown(markdown: string, opts: ChunkOptions): ChunkRow[] {
  const targetSize = opts.targetSize ?? TARGET_SIZE;
  const overlap = opts.overlap ?? OVERLAP;
  const folios = scanFolios(markdown);
  const isInsideCodeFence = buildCodeFenceMask(markdown);

  const rows: ChunkRow[] = [];
  const len = markdown.length;
  if (len === 0) return rows;

  let start = 0;
  let chunkIndex = 0;
  // Guard against pathological non-progress.
  let guard = 0;
  const guardMax = Math.ceil((len / Math.max(1, targetSize - overlap)) * 4) + 16;

  while (start < len) {
    if (++guard > guardMax) {
      throw new Error(
        `chunkMarkdown: split loop failed to make progress at start=${start}`,
      );
    }

    const idealEnd = Math.min(len, start + targetSize);
    let end: number;
    if (idealEnd >= len) {
      end = len;
    } else {
      end = findBreakOffset(markdown, start, idealEnd, isInsideCodeFence);
      // Ensure progress: at minimum, advance to idealEnd.
      if (end <= start) end = Math.min(len, start + targetSize);
    }

    const text = markdown.slice(start, end).trim();
    if (text.length > 0) {
      const folio = folioAt(folios, start);
      const metadata: ChunkRow["metadata"] = {
        ...opts.baseMetadata,
        ark: opts.baseMetadata.ark,
        arkSlug: opts.baseMetadata.arkSlug,
      };
      if (opts.baseMetadata.docType !== undefined) {
        metadata.docType = opts.baseMetadata.docType;
      }
      if (folio !== undefined) {
        metadata.folio = folio;
        const perFolio = opts.folioMetadata?.get(folio);
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

    if (end >= len) break;
    // Step forward by (chunk size - overlap), but never go backwards or stall.
    const step = Math.max(1, end - start - overlap);
    start = start + step;
  }

  return rows;
}
