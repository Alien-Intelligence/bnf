/**
 * In-memory DocStateStore for unit tests. Single-threaded JS → folio recording is
 * trivially atomic; idempotency is enforced by keying landed folios in a Set.
 */
import type { DocMeta } from "./types.js";
import type { Lane } from "./queues.js";
import type {
  DocRow,
  DocScope,
  DocStateStore,
  DocStatus,
  FailedDoc,
  FolioTally,
} from "./doc-state.js";

interface Entry extends DocRow {
  folios: Map<number, boolean>; // ordre → ok
}

export class MemoryDocState implements DocStateStore {
  private readonly docs = new Map<string, Entry>();

  async upsertDoc(d: {
    docJobId: string;
    projectId: string;
    ark: string;
    runId?: string | null;
  }): Promise<void> {
    if (this.docs.has(d.docJobId)) return;
    this.docs.set(d.docJobId, {
      docJobId: d.docJobId,
      runId: d.runId ?? null,
      projectId: d.projectId,
      ark: d.ark,
      lane: null,
      status: "queued",
      pagesExpected: null,
      pagesDone: 0,
      pagesFailed: 0,
      meta: null,
      error: null,
      skipReason: null,
      folios: new Map(),
    });
  }

  private require(docJobId: string): Entry {
    const e = this.docs.get(docJobId);
    if (!e) throw new Error(`doc-state: unknown docJobId ${docJobId}`);
    return e;
  }

  async recordPlan(
    docJobId: string,
    plan: { lane: Lane; pagesExpected: number; meta: DocMeta },
  ): Promise<void> {
    const e = this.require(docJobId);
    e.lane = plan.lane;
    e.pagesExpected = plan.pagesExpected;
    e.meta = plan.meta;
    e.status = "planned";
  }

  async recordFolio(docJobId: string, ordre: number, ok: boolean): Promise<FolioTally> {
    const e = this.require(docJobId);
    if (!e.folios.has(ordre)) e.folios.set(ordre, ok); // idempotent: first write wins
    let done = 0;
    let failed = 0;
    for (const v of e.folios.values()) {
      if (v) done++;
      else failed++;
    }
    e.pagesDone = done;
    e.pagesFailed = failed;
    const expected = e.pagesExpected ?? 0;
    return { expected, done, failed, complete: expected > 0 && done + failed >= expected };
  }

  async setStatus(
    docJobId: string,
    status: DocStatus,
    extra?: { error?: string; skipReason?: string },
  ): Promise<void> {
    const e = this.require(docJobId);
    e.status = status;
    if (extra?.error !== undefined) e.error = extra.error;
    if (extra?.skipReason !== undefined) e.skipReason = extra.skipReason;
  }

  async claimRoute(
    docJobId: string,
    status: "ready" | "failed",
    extra?: { error?: string; skipReason?: string },
  ): Promise<boolean> {
    const e = this.require(docJobId);
    const preRouted = e.status === "queued" || e.status === "planned" || e.status === "fetching";
    if (!preRouted) return false;
    e.status = status;
    if (extra?.error !== undefined) e.error = extra.error;
    if (extra?.skipReason !== undefined) e.skipReason = extra.skipReason;
    return true;
  }

  async get(docJobId: string): Promise<DocRow | null> {
    const e = this.docs.get(docJobId);
    if (!e) return null;
    const { folios: _folios, ...row } = e;
    return { ...row };
  }

  async listOkFolios(docJobId: string): Promise<number[]> {
    const e = this.docs.get(docJobId);
    if (!e) return [];
    return [...e.folios.entries()].filter(([, ok]) => ok).map(([ordre]) => ordre).sort((a, b) => a - b);
  }

  async statusCounts(scope?: DocScope): Promise<Record<DocStatus, number>> {
    const out: Record<DocStatus, number> = {
      queued: 0, planned: 0, fetching: 0, ready: 0, processing: 0,
      done: 0, failed: 0, skipped: 0, excluded: 0,
    };
    for (const e of this.docs.values()) {
      if (scope?.runId !== undefined && e.runId !== scope.runId) continue;
      if (scope?.projectId !== undefined && e.projectId !== scope.projectId) continue;
      out[e.status] += 1;
    }
    return out;
  }

  async listFailedDocs(runId: string): Promise<FailedDoc[]> {
    return [...this.docs.values()]
      .filter((e) => e.runId === runId && e.status === "failed")
      .sort((a, b) => a.ark.localeCompare(b.ark))
      .map((e) => ({ ark: e.ark, lane: e.lane, error: e.error }));
  }

  async donePageCount(runId: string): Promise<number> {
    let pages = 0;
    for (const e of this.docs.values()) {
      if (e.runId !== runId || e.status !== "done") continue;
      for (const ok of e.folios.values()) if (ok) pages += 1;
    }
    return pages;
  }
}
