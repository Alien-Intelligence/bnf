/**
 * Typed wrappers over the data-cluster REST endpoints we use.
 *
 * Endpoints (all under {baseUrl} = {BACKEND_API_URL}/clusters/{CLUSTER_ID}/proxy):
 *   GET  /api/v1/datasets/slug/{slug}                    → DatasetView | 404
 *   POST /api/v1/datasets                                → DatasetView
 *   POST /api/v1/entries                                 → { entry: EntryView } | EntryView
 *   POST /api/v1/entries/{entryId}/upload (multipart)    → UploadResponse
 *   POST /api/v1/entries/{entryId}/processed             → ProcessedResponse
 *   POST /api/v1/entries/{entryId}/chunks                → IndexChunksResponse
 *
 * The cluster API has historically shipped both `{ entry: {...} }` and bare
 * `{...}` shapes for create-entry; we accept either.
 */
import { FormData } from "undici";
import { ClusterHttp } from "./http.js";

export interface DatasetView {
  id: number;
  name: string;
  slug: string;
  dataset_type?: string;
}

export interface EntryView {
  id: number;
  dataset_id?: number;
  name?: string;
  slug?: string;
  manifest?: {
    original?: {
      metadata?: Record<string, unknown>;
    };
  };
}

interface CreateEntryResponse {
  // The Python e2e accesses `response.entry`, but some routes return the
  // entry directly. Accept either.
  entry?: EntryView;
  id?: number;
}

export interface CreateDatasetInput {
  name: string;
  slug: string;
  description?: string;
  dataset_type?: string;
  schema_definition: Record<string, unknown>;
}

export interface CreateEntryInput {
  dataset_id: number;
  name: string;
  slug: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface IndexChunkInput {
  chunk_text: string;
  chunk_index: number;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export class ClusterClient {
  constructor(private readonly http: ClusterHttp = new ClusterHttp()) {}

  async getDatasetBySlug(slug: string): Promise<DatasetView | null> {
    return this.http.getJsonOrNull<DatasetView>(
      `/api/v1/datasets/slug/${encodeURIComponent(slug)}`,
    );
  }

  async createDataset(input: CreateDatasetInput): Promise<DatasetView> {
    return this.http.postJson<DatasetView>("/api/v1/datasets", {
      dataset_type: "text",
      ...input,
    });
  }

  /**
   * Find an entry by (datasetId, slug). The cluster's list endpoint doesn't
   * actually honor a `slug` query parameter — it returns all entries — so we
   * page and filter client-side. Returns null when not found.
   *
   * Paginates conservatively (page_size=100, max 50 pages = 5k entries per
   * dataset). For BnF projects in the thousands this is fine; larger
   * deployments should add a server-side slug index.
   */
  async findEntryBySlug(datasetId: number, slug: string): Promise<EntryView | null> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.http.getJson<{
        entries?: EntryView[];
        total?: number;
        total_pages?: number;
      }>(
        `/api/v1/entries?dataset_id=${datasetId}&page=${page}&page_size=${PAGE_SIZE}`,
      );
      const hit = (res.entries ?? []).find((e) => e.slug === slug);
      if (hit) {
        // Re-fetch full entry to get the manifest.original.metadata
        // (list endpoint sometimes returns a stripped view).
        return await this.http.getJson<EntryView>(`/api/v1/entries/${hit.id}`);
      }
      const totalPages = res.total_pages ?? 1;
      if (page >= totalPages) return null;
    }
    return null;
  }

  async deleteEntry(entryId: number): Promise<void> {
    await this.http.deleteJson<unknown>(`/api/v1/entries/${entryId}`);
  }

  async createEntry(input: CreateEntryInput): Promise<EntryView> {
    const res = await this.http.postJson<CreateEntryResponse | EntryView>(
      "/api/v1/entries",
      input,
    );
    if (res && typeof res === "object" && "entry" in res && res.entry) {
      return res.entry;
    }
    if (res && typeof res === "object" && "id" in res && typeof (res as EntryView).id === "number") {
      return res as EntryView;
    }
    throw new Error(`createEntry: unexpected response shape: ${JSON.stringify(res).slice(0, 200)}`);
  }

  async uploadOriginalFile(
    entryId: number,
    filename: string,
    bytes: Buffer | Uint8Array | string,
    fileType: "original" | "processing" | "processed" = "original",
  ): Promise<unknown> {
    // Factory (not a built FormData): the http layer retries transient
    // failures and must rebuild the multipart body on each attempt.
    const formFactory = (): FormData => {
      const form = new FormData();
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      form.set("file", blob, filename);
      form.set("file_type", fileType);
      return form;
    };
    return this.http.postForm<unknown>(`/api/v1/entries/${entryId}/upload`, formFactory);
  }

  async saveProcessedContent(entryId: number, text: string): Promise<unknown> {
    return this.http.postJson<unknown>(`/api/v1/entries/${entryId}/processed`, {
      content: { text },
    });
  }

  async indexChunks(
    entryId: number,
    chunks: IndexChunkInput[],
    collectionName = "entry_chunks",
  ): Promise<unknown> {
    return this.http.postJson<unknown>(`/api/v1/entries/${entryId}/chunks`, {
      chunks,
      collection_name: collectionName,
    });
  }
}
