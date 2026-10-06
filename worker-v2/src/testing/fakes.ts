/**
 * In-memory fakes for the BnF client + the four downstream ports, with explicit
 * fault injection (transient 5xx that recover after N attempts, permanent 4xx,
 * always-failing folios, manifest-500). These let the whole pipeline run end to
 * end — every lane, plus retry/failure/observability — with zero network and zero
 * BnF quota. The live clients (ported from V1) implement the same interfaces.
 */
import { PermanentBnfError, TransientBnfError } from "../bnf/errors.js";
import { altoFolioFromParse, emptyAltoFolio, parseAlto } from "../bnf/parse.js";
import { DOC_INFO_SOURCE, type AltoFolio, type BnfClient, type BnfDocInfo, type Manifest } from "../bnf/types.js";
import type { ClusterSink, Describer, Embedder, OcrEngine, OcrBatchStatus } from "../ports.js";
import type { PreparedPage } from "../domain/types.js";

/** A scripted fault: throw a transient `status` for the first `transientTimes`
 *  calls, then succeed; or `permanent:true` to throw a PermanentBnfError every
 *  time; or `alwaysTransient:true` to never recover (→ exhaust retries). */
export interface Fault {
  status?: number;
  transientTimes?: number;
  permanent?: boolean;
  alwaysTransient?: boolean;
}

class FaultCounter {
  private readonly seen = new Map<string, number>();
  /** Returns true (and throws via caller) when this key should fault on this call. */
  hit(key: string, fault: Fault | undefined): void {
    if (!fault) return;
    if (fault.permanent) {
      throw new PermanentBnfError("forbidden", { status: fault.status ?? 403, hint: key });
    }
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    if (fault.alwaysTransient) {
      throw new TransientBnfError("server_error", { status: fault.status ?? 500, hint: key });
    }
    if (fault.transientTimes && n <= fault.transientTimes) {
      throw new TransientBnfError("server_error", { status: fault.status ?? 500, hint: key });
    }
  }
}

export interface FakeDocSpec {
  ark: string;
  ocrAvailable: boolean;
  docType: string | null;
  /**
   * The page count BnF publishes; `null` = it publishes none. The OAI path
   * carries it as is (pageCount null); a manifest always has a canvas count,
   * so the fake manifest of a `null` doc has no canvases.
   */
  pageCount: number | null;
  title?: string | null;
  /** Folios (ordre) that have no ALTO text — fetched ok but empty. */
  emptyFolios?: number[];
  /**
   * Mean word confidence the fake reports per ALTO folio. Default 1 (a fully
   * confident fake OCR, so every unrelated test reads "not low"); `null` models
   * an ALTO without WC. The real client derives this from the XML (parseAlto).
   */
  folioMeanWc?: Record<number, number | null>;
  /**
   * Raw WC attribute values, one per word of the folio's fake text (6 words),
   * written verbatim into the fake ALTO — so a test can script values the real
   * parser must reject ("abc", "1.5") and see invalidWcCount. Overrides
   * folioMeanWc for that folio; null omits WC on that word.
   */
  folioWc?: Record<number, Array<string | null>>;
  /**
   * The raw "Taux OCR" metadata value the fake manifest publishes when
   * `ocrAvailable` (default "100%"). Any string — "78.21 %", "n/a", "150 %" — so
   * tests can drive every parseOcrRate outcome through the real parsing path.
   */
  tauxOcr?: string;
  /** Image folios (ordre) served TRUNCATED (valid SOI, missing EOI) — the
   *  poisoned-transport shape the fetch stage must reject, never cache. */
  truncatedFolios?: number[];
  /**
   * The canvas dims the fake manifest declares for every canvas (default
   * FAKE_CANVAS, 1000×1400). A null dim models a manifest that omits it; the
   * fake image master then keeps FAKE_CANVAS's size.
   */
  canvas?: { width: number | null; height: number | null };
  /**
   * Fault on getManifest — the PRIMARY path for both metadata resolution
   * (MetadataStage) and canvas fan-out (ManifestStage); both stages share one
   * call/cache per ARK, so this one knob covers both callers.
   */
  manifestFault?: Fault;
  /**
   * Fault on getDocumentInfoViaOai — the metadata FALLBACK, reached only when
   * getManifest throws Permanent. To make a doc fail metadata resolution
   * entirely (the old "permanent metadata error" scenario), set BOTH
   * `manifestFault: { permanent: true }` and `oaiFault: { permanent: true }`.
   */
  oaiFault?: Fault;
  /** Faults per folio fetch (ALTO or image), keyed by ordre. */
  folioFaults?: Record<number, Fault>;
}

/** The mean WC a fake ALTO word carries unless the spec says otherwise: fully
 *  confident, so every unrelated test reads "not low". `null` = no WC at all. */
const FAKE_DEFAULT_WC = "1";

function fakeMeanWc(mean: number | null | undefined): string | null {
  if (mean === undefined) return FAKE_DEFAULT_WC;
  return mean === null ? null : String(mean);
}

function xmlAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The canvas (and image master) dims of a fake doc unless its spec says otherwise. */
export const FAKE_CANVAS = { width: 1000, height: 1400 } as const;

/**
 * A minimal, structurally complete JPEG declaring `width`×`height` in a SOF0
 * frame header: SOI, SOF0, SOS, `payload` as scan data, EOI — what
 * isCompleteJpeg and jpegDimensions read. Test fixtures only.
 */
export function fakeJpeg(width: number, height: number, payload: Buffer = Buffer.alloc(1)): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    payload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * The output dims of a IIIF Image v3 `size` on a master, as BnF answers it:
 * `max` is the master; `!w,h` fits the master into the box, and is a 400 when
 * that would UPSCALE (BnF accepts no `^`). Any other size is refused here so a
 * test catches the worker sending one.
 */
function iiifOutputDims(master: { width: number; height: number }, size: string): { width: number; height: number } {
  if (size === "max") return master;
  const box = /^!(\d+),(\d+)$/.exec(size);
  if (!box) throw new Error(`FakeBnfClient: the worker sent an unexpected IIIF size "${size}"`);
  const w = Number(box[1]);
  const h = Number(box[2]);
  const scale = Math.min(w / master.width, h / master.height);
  if (scale > 1) {
    throw new PermanentBnfError("bad_ark", {
      status: 400,
      hint: `size ${size} would upscale a ${master.width}x${master.height} master (BnF strict IIIF v3)`,
    });
  }
  return { width: Math.round(master.width * scale), height: Math.round(master.height * scale) };
}

/** The Presentation API base the fake's manifest URLs hang off. */
export const FAKE_PRESENTATION_BASE = "https://presentation.fake.bnf.test/presentation/iiif/gallica/1.0.0";

/** The Taux OCR a fake text document publishes unless its spec says otherwise. */
const FAKE_DEFAULT_TAUX_OCR = "100%";

export class FakeBnfClient implements BnfClient {
  private readonly docs = new Map<string, FakeDocSpec>();
  private readonly faults = new FaultCounter();
  readonly calls = { oai: 0, manifest: 0, alto: 0, image: 0 };
  /** Every image fetch, with the IIIF size the worker asked for. */
  readonly imageFetches: Array<{ ark: string; ordre: number; size: string }> = [];

  add(spec: FakeDocSpec): this {
    this.docs.set(spec.ark, spec);
    return this;
  }

  private spec(ark: string): FakeDocSpec {
    const s = this.docs.get(ark);
    if (!s) throw new PermanentBnfError("not_found", { status: 404, hint: ark });
    return s;
  }

  async getDocumentInfoViaOai(ark: string): Promise<BnfDocInfo> {
    this.calls.oai++;
    const s = this.spec(ark);
    this.faults.hit(`oai:${ark}`, s.oaiFault);
    return {
      ark,
      title: s.title ?? `Doc ${ark}`,
      creator: null,
      date: null,
      docType: s.docType,
      subtype: null,
      ocrAvailable: s.ocrAvailable,
      // The OAI path publishes no Taux OCR (client.ts getDocumentInfoViaOai).
      ocrRate: null,
      pageCount: s.pageCount,
      iiifManifestUrl: null,
      lang: "fre",
      raw: { source: DOC_INFO_SOURCE.OAI_PMH },
    };
  }

  async getManifest(ark: string, maxCanvases: number): Promise<Manifest> {
    this.calls.manifest++;
    const s = this.spec(ark);
    this.faults.hit(`manifest:${ark}`, s.manifestFault);
    const canvasCount = s.pageCount ?? 0; // a manifest always has a canvas list (see FakeDocSpec.pageCount)
    const dims = s.canvas ?? FAKE_CANVAS;
    const canvases = Array.from({ length: Math.min(canvasCount, maxCanvases) }, (_, i) => ({
      ordre: i + 1,
      label: `f${i + 1}`,
      width: dims.width,
      height: dims.height,
    }));
    // Mirror the real IIIF manifest's label/value metadata pairs so
    // docInfoFromManifest (client.ts) derives the SAME docType/ocrAvailable the
    // spec declares, through the SAME parsing path the live client uses — not a
    // shortcut that bypasses it. (This is exactly the gap that let F1/F2 go
    // untested: the old fake's getDocumentInfo built a BnfDocInfo directly and
    // never round-tripped through a manifest at all.)
    const metadata: Array<{ label: string; value: string }> = [{ label: "langue", value: "fre" }];
    if (s.docType) metadata.push({ label: "type document", value: s.docType });
    if (s.ocrAvailable) metadata.push({ label: "taux ocr", value: s.tauxOcr ?? FAKE_DEFAULT_TAUX_OCR });
    return { title: s.title ?? `Doc ${ark}`, metadata, totalPages: canvasCount, canvases };
  }

  async fetchAltoFolio(ark: string, ordre: number, signal?: AbortSignal): Promise<AltoFolio> {
    signal?.throwIfAborted();
    this.calls.alto++;
    const s = this.spec(ark);
    this.faults.hit(`folio:${ark}:${ordre}`, s.folioFaults?.[ordre]);
    if (s.emptyFolios?.includes(ordre)) return emptyAltoFolio();
    // A real ALTO document, parsed by the REAL parser (range check, invalid WC
    // count, rounding) and mapped by the SAME altoFolioFromParse the live
    // client uses — so the fake cannot report a quality the client never could.
    const words = `ALTO text of ${ark} folio ${ordre}`.split(" ");
    const wcs = s.folioWc?.[ordre] ?? words.map(() => fakeMeanWc(s.folioMeanWc?.[ordre]));
    if (wcs.length !== words.length) {
      throw new Error(`fake folioWc[${ordre}] must hold ${words.length} values, got ${wcs.length}`);
    }
    const strings = words
      .map((w, i) => {
        const wc = wcs[i];
        return `<String CONTENT="${xmlAttr(w)}"${wc === null || wc === undefined ? "" : ` WC="${xmlAttr(wc)}"`}/>`;
      })
      .join("");
    const xml = `<alto><Layout><Page><PrintSpace><TextBlock><TextLine>${strings}</TextLine></TextBlock></PrintSpace></Page></Layout></alto>`;
    return altoFolioFromParse(parseAlto(xml));
  }

  manifestUrl(canonicalArk: string): string {
    return `${FAKE_PRESENTATION_BASE}/presentation/v3/${canonicalArk}/manifest.json`;
  }

  async fetchImageFolio(ark: string, ordre: number, size: string): Promise<Buffer> {
    this.calls.image++;
    this.imageFetches.push({ ark, ordre, size });
    const s = this.spec(ark);
    this.faults.hit(`folio:${ark}:${ordre}`, s.folioFaults?.[ordre]);
    const master = {
      width: s.canvas?.width ?? FAKE_CANVAS.width,
      height: s.canvas?.height ?? FAKE_CANVAS.height,
    };
    const out = iiifOutputDims(master, size);
    // A STRUCTURALLY valid JPEG (SOI, a frame header with the served dims,
    // payload, EOI) — the fetch stage validates completeness before caching
    // (isCompleteJpeg) and reads the dims back for the cache rule.
    // `truncatedFolios` opts a folio into the truncated shape (valid SOI, no
    // EOI) to exercise the rejection path.
    const jpeg = fakeJpeg(out.width, out.height, Buffer.from(`IMG ${ark} f${ordre}`, "utf8"));
    if (s.truncatedFolios?.includes(ordre)) return jpeg.subarray(0, jpeg.length - 2);
    return jpeg;
  }
}

export class FakeDescriber implements Describer {
  async describe(input: { ark: string; ordre: number }): Promise<string> {
    return `Description of ${input.ark} folio ${input.ordre}`;
  }
}

/** Options for FakeOcrEngine — beyond the default "every folio survives",
 *  individual ordres can be scripted to drop (empty/hallucinated) or error at
 *  the request level, so tests can exercise F13/F14's honest-outcome paths
 *  (zero survivors, partial survivors + recorded drops) without the real
 *  Mistral SDK. */
export interface FakeOcrOpts {
  pendingPolls?: number;
  /** Synthetic terminal batch failure (mirrors a TIMEOUT_EXCEEDED/FAILED batch). */
  fail?: boolean;
  /** Ordres dropped as hallucinated (simulates looksLikeHallucinatedOcr). */
  hallucinatedOrdres?: number[];
  /** Ordres dropped as legitimately empty/blank. */
  emptyOrdres?: number[];
  /** Ordres reported as a per-entry request error instead of a page. */
  errorOrdres?: number[];
}

/** OCR engine that completes after `pendingPolls` polls (default 1 = immediate done). */
export class FakeOcrEngine implements OcrEngine {
  private readonly polls = new Map<string, number>();
  private readonly batchFolios = new Map<string, number[]>();
  readonly submitted: string[] = [];
  constructor(private readonly opts: FakeOcrOpts = {}) {}

  async submitBatch(input: {
    ark: string;
    folios: Array<{ ordre: number }>;
  }): Promise<{ batchId: string }> {
    const batchId = `batch-${input.ark}`;
    this.submitted.push(batchId);
    this.batchFolios.set(batchId, input.folios.map((f) => f.ordre));
    return { batchId };
  }

  async pollBatch(batchId: string): Promise<OcrBatchStatus> {
    if (this.opts.fail) return { state: "failed", reason: "synthetic" };
    const n = (this.polls.get(batchId) ?? 0) + 1;
    this.polls.set(batchId, n);
    if (n < (this.opts.pendingPolls ?? 1)) return { state: "pending" };

    const ordres = this.batchFolios.get(batchId) ?? [];
    const hallucinated = new Set(this.opts.hallucinatedOrdres ?? []);
    const empty = new Set(this.opts.emptyOrdres ?? []);
    const errored = new Set(this.opts.errorOrdres ?? []);

    const pages: PreparedPage[] = [];
    const entryErrors: Array<{ ordre: number | null; error: string }> = [];
    let droppedEmpty = 0;
    let droppedHallucinated = 0;
    for (const ordre of ordres) {
      if (errored.has(ordre)) {
        entryErrors.push({ ordre, error: "synthetic_entry_error" });
        continue;
      }
      if (hallucinated.has(ordre)) {
        droppedHallucinated++;
        continue;
      }
      if (empty.has(ordre)) {
        droppedEmpty++;
        continue;
      }
      pages.push({ ordre, text: `OCR text folio ${ordre}` });
    }
    return {
      state: "done",
      pages,
      dropped: { empty: droppedEmpty, hallucinated: droppedHallucinated },
      entryErrors,
      succeeded: pages.length,
      failed: entryErrors.length,
    };
  }
}

export class FakeEmbedder implements Embedder {
  readonly dim = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => [t.length, 1, 2, 3]);
  }
}

export class FakeClusterSink implements ClusterSink {
  readonly upserts: Array<{ ark: string; datasetId: number; pages: number }> = [];
  private nextEntry = 1;
  private nextDataset = 1;
  private readonly datasetIdByProject = new Map<string, number>();

  // One dataset id per projectId, assigned on first ensureDataset() and stable
  // thereafter (real per-project datasets) — see register.test's F16 coverage,
  // which needs two distinct projects ingesting the same ARK to land in two
  // distinct datasets.
  async ensureDataset(input: { projectId: string }): Promise<{ datasetId: number }> {
    let id = this.datasetIdByProject.get(input.projectId);
    if (id === undefined) {
      id = this.nextDataset++;
      this.datasetIdByProject.set(input.projectId, id);
    }
    return { datasetId: id };
  }

  async upsert(input: {
    datasetId: number;
    ark: string;
    pages: PreparedPage[];
  }): Promise<{ entryId: number }> {
    this.upserts.push({ ark: input.ark, datasetId: input.datasetId, pages: input.pages.length });
    return { entryId: this.nextEntry++ };
  }

  /** Test hook: simulate a project's dataset being deleted and recreated —
   *  the next ensureDataset() call for `projectId` returns a NEW id. */
  recreateDataset(projectId: string): number {
    const id = this.nextDataset++;
    this.datasetIdByProject.set(projectId, id);
    return id;
  }
}
