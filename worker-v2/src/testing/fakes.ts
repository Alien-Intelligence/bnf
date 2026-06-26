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
  /** Fault on getDocumentInfo. */
  metadataFault?: Fault;
  /** Fault on getManifest. */
  manifestFault?: Fault;
  /** Faults per folio fetch (ALTO or image), keyed by ordre. */
  folioFaults?: Record<number, Fault>;
}

export class FakeBnfClient implements BnfClient {
  private readonly docs = new Map<string, FakeDocSpec>();
  private readonly faults = new FaultCounter();
  readonly calls = { metadata: 0, manifest: 0, alto: 0, image: 0 };

  add(spec: FakeDocSpec): this {
    this.docs.set(spec.ark, spec);
    return this;
  }

  private spec(ark: string): FakeDocSpec {
    const s = this.docs.get(ark);
    if (!s) throw new PermanentBnfError("not_found", { status: 404, hint: ark });
    return s;
  }

  async getDocumentInfo(ark: string): Promise<BnfDocInfo> {
    this.calls.metadata++;
    const s = this.spec(ark);
    this.faults.hit(`meta:${ark}`, s.metadataFault);
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
    return { title: s.title ?? null, metadata: [], totalPages: s.pageCount, canvases };
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

/** OCR engine that completes after `pendingPolls` polls (default 1 = immediate done). */
export class FakeOcrEngine implements OcrEngine {
  private readonly polls = new Map<string, number>();
  private readonly batchFolios = new Map<string, number[]>();
  readonly submitted: string[] = [];
  constructor(private readonly opts: { pendingPolls?: number; fail?: boolean } = {}) {}

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
    const pages: PreparedPage[] = ordres.map((ordre) => ({ ordre, text: `OCR text folio ${ordre}` }));
    return { state: "done", pages };
  }
}

export class FakeEmbedder implements Embedder {
  readonly dim = 4;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => [t.length, 1, 2, 3]);
  }
}

export class FakeClusterSink implements ClusterSink {
  readonly upserts: Array<{ ark: string; pages: number }> = [];
  private nextEntry = 1;
  async ensureDataset(): Promise<{ datasetId: number }> {
    return { datasetId: 1 };
  }
  async upsert(input: { ark: string; pages: PreparedPage[] }): Promise<{ entryId: number }> {
    this.upserts.push({ ark: input.ark, pages: input.pages.length });
    return { entryId: this.nextEntry++ };
  }
}
