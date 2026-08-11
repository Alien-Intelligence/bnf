/**
 * In-memory fakes for the BnF client + the four downstream ports, with explicit
 * fault injection (transient 5xx that recover after N attempts, permanent 4xx,
 * always-failing folios, manifest-500). These let the whole pipeline run end to
 * end — every lane, plus retry/failure/observability — with zero network and zero
 * BnF quota. The live clients (ported from V1) implement the same interfaces.
 */
import { PermanentBnfError, TransientBnfError } from "../bnf/errors.js";
import type { AltoFolio, BnfClient, BnfDocInfo, Manifest } from "../bnf/types.js";
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
  pageCount: number;
  title?: string | null;
  /** Folios (ordre) that have no ALTO text — fetched ok but empty. */
  emptyFolios?: number[];
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

export class FakeBnfClient implements BnfClient {
  private readonly docs = new Map<string, FakeDocSpec>();
  private readonly faults = new FaultCounter();
  readonly calls = { oai: 0, manifest: 0, alto: 0, image: 0 };

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
      pageCount: s.pageCount,
      iiifManifestUrl: null,
      lang: "fre",
      raw: {},
    };
  }

  async getManifest(ark: string, maxCanvases: number): Promise<Manifest> {
    this.calls.manifest++;
    const s = this.spec(ark);
    this.faults.hit(`manifest:${ark}`, s.manifestFault);
    const canvases = Array.from({ length: Math.min(s.pageCount, maxCanvases) }, (_, i) => ({
      ordre: i + 1,
      label: `f${i + 1}`,
      width: 1000,
      height: 1400,
    }));
    // Mirror the real IIIF manifest's label/value metadata pairs so
    // docInfoFromManifest (client.ts) derives the SAME docType/ocrAvailable the
    // spec declares, through the SAME parsing path the live client uses — not a
    // shortcut that bypasses it. (This is exactly the gap that let F1/F2 go
    // untested: the old fake's getDocumentInfo built a BnfDocInfo directly and
    // never round-tripped through a manifest at all.)
    const metadata: Array<{ label: string; value: string }> = [{ label: "langue", value: "fre" }];
    if (s.docType) metadata.push({ label: "type document", value: s.docType });
    if (s.ocrAvailable) metadata.push({ label: "taux ocr", value: "100%" });
    return { title: s.title ?? `Doc ${ark}`, metadata, totalPages: s.pageCount, canvases };
  }

  async fetchAltoFolio(ark: string, ordre: number): Promise<AltoFolio> {
    this.calls.alto++;
    const s = this.spec(ark);
    this.faults.hit(`folio:${ark}:${ordre}`, s.folioFaults?.[ordre]);
    if (s.emptyFolios?.includes(ordre)) return { text: "", empty: true };
    return { text: `ALTO text of ${ark} folio ${ordre}`, empty: false };
  }

  async fetchImageFolio(ark: string, ordre: number, _size?: string): Promise<Buffer> {
    this.calls.image++;
    const s = this.spec(ark);
    this.faults.hit(`folio:${ark}:${ordre}`, s.folioFaults?.[ordre]);
    return Buffer.from(`IMG ${ark} f${ordre}`, "utf8");
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
