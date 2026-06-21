# bnf-ingest sandbox

End-to-end ingestion pipeline for BnF documents into a data cluster, structured as three independently-built tracks composed by a queue.

## Architecture

```
ARK
 │
 │  Track 1 — prepare (src/prepare/)
 │  ├── has BnF OCR? → fetch via MCP → render doc.md
 │  ├── single image? → IIIF → Holo2 description → render doc.md
 │  └── neither     → SkipReason
 │
 │  chunked + persisted to BlobStore:
 │    s3://bnf-corpus-demo/projects/<id>/docs/<arkSlug>/{doc.md, doc.json, chunks.jsonl}
 │
 ▼
PreparedDoc { metadata, markdown, chunks[], contentHash, blobKeys }
 │
 │  Track 3 — embed + cluster (src/embed/, src/cluster/)
 │  ├── embed chunks via RunPod bge-m3
 │  ├── create entry (cluster API, with metadata)
 │  ├── upload doc.md as original
 │  ├── save processed content (the markdown body)
 │  └── index chunks with pre-computed vectors
 │
 ▼
UpsertResult { entryId, chunksWritten, timings }

 ⤴ orchestrated by Track 2 — queue (src/queue/)
   pg-boss DocumentIngestJob queue, worker process composes Track 1 → Track 3,
   updates DocumentIngestState per ARK so the corpus UI can show ✓/✗/⏳.
```

## Track ownership

| Track | Owns | Reads (frozen, don't mutate) | Smoke script |
|---|---|---|---|
| 1 — prepare | `src/prepare/`, `scripts/01-prepare-one.ts` | `src/types.ts`, `src/blob/*`, `src/slug.ts`, `src/env.ts` | `npm run prepare:one -- <ARK>` |
| 2 — queue | `src/queue/`, `scripts/04-worker.ts`, `scripts/05-submit.ts` | `src/types.ts` (only as type imports) | `npm run worker` (long-running) |
| 3 — embed + cluster | `src/embed/`, `src/cluster/`, `scripts/02-embed-one.ts`, `scripts/03-register-one.ts` | `src/types.ts`, `src/blob/*` | `npm run embed:one`, `npm run register:one -- <projectId> <ARK>` |

## Shared contracts (frozen — see `src/types.ts`)

```ts
interface DocPipeline {
  prepare(input: { projectId: string; ark: string }): Promise<PreparedDoc | SkipReason>;
}

interface ClusterSink {
  ensureDataset(input: { projectId: string; name: string; slug: string }): Promise<{ datasetId: number }>;
  upsert(input: { datasetId: number; prepared: PreparedDoc }): Promise<UpsertResult>;
}
```

Track 2's worker depends only on these two interfaces; it imports `DocPipeline` from Track 1 and `ClusterSink` from Track 3 at the composition root in `scripts/04-worker.ts`.

## Local setup

Postgres comes from the parent `bnf/docker-compose.yml`:

```bash
cd ..              # back to bnf/
docker compose up -d postgres
# Postgres available at localhost:5437, db=bnf_dev, user=bnf_user
cd sandbox/bnf-ingest
cp .env.example .env
# Fill in BNF_MCP_*, SCW_*, RUNPOD_*, CLUSTER_*
npm install
npm run typecheck
```

## Reference shapes (for Track agents)

- **BnF MCP tools** — see `bnf/lib/mcp/bnf-client.ts` and `bnf/lib/mcp/vocab.ts`. Tools we call: `bnf_get_document_info`, `bnf_get_document_text`, `bnf_get_image_url`, `bnf_get_manifest`.
- **Holo2 prompt + parser** — already prototyped in `bnf/sandbox/bnf-images/src/gemma.ts` (model-agnostic, reuse the `describeImage` function + `ImageDescription` type).
- **Cluster API shape** — see `DataStreaming/sandbox/e2e-test/registration_e2e.py` lines 468-557 for the full create-entry → upload → save-processed → index-chunks flow.
- **RunPod request shape** — see `DataStreaming/data-pipelines/alienargo/services/embeddings/runpod.py`. Note: body is `{ input: { model, input: chunks[], encoding_format: "float" } }` (`input` not `inputs`).
- **Reference doc cache layout** — see `DataStreaming/sandbox/e2e-test/cache/Cardiovascular_Medicine/10.1101_2022.06.01.22275807/` for the `article.md` + `article.json` + `embeddings.parquet` shape (we drop figures + parquet; chunks.jsonl replaces parquet).

## Build order

1. Scaffolded shared core (this) — `src/env.ts`, `src/types.ts`, `src/slug.ts`, `src/blob/*` — frozen.
2. Three tracks in parallel.
3. Composition + smoke runs.
