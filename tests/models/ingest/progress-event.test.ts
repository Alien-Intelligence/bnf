// tests/models/ingest/progress-event.test.ts
// clusterProgressEventSchema — found bug B2 (feedback 2026-09-29, Track B).
//
// POST /api/internal/ingest/[job_id]/progress used to `JSON.parse(body) as
// ClusterProgressEvent`: a correctly signed but malformed event reached
// IngestService.applyProgress unvalidated, where e.g. a `done` without
// `chunksWritten` committed the version with `undefined` chunks. The route now
// validates against this schema and answers 400 with the issues.
//
// The two terminal fixtures are copied from worker-v2's buildTerminalEvent
// output (worker-v2/src/live/progress-callback.ts), the running one from the
// fake cluster (lib/cluster/fake.ts).
import { test } from "node:test"
import assert from "node:assert/strict"

import { clusterProgressEventSchema } from "@/models/ingest/types"

const DONE_EVENT = {
  stage: "done",
  chunksWritten: 42,
  stats: {
    total: 3,
    done: 2,
    failed: 1,
    skipped: 0,
    errors: [
      { ark: "ark:/12148/bpt6k000001", stage: "text", reason: "page-fail-ratio 3/4 > 0.5" },
      {
        ark: "ark:/12148/bpt6k000002",
        stage: "mistral",
        reason: "pages partiellement illisibles: 2/10 pages OCR rejetées (cause inconnue)",
        warning: true,
      },
    ],
  },
}

const FAILED_EVENT = {
  stage: "failed",
  error: "every ingestable document failed",
  partialStats: { total: 1, done: 0, failed: 1, skipped: 0, errors: [] },
}

const RUNNING_EVENT = { stage: "embed", fraction: 0.6, counters: { docs: 3 } }

test("accepts the worker's done event", () => {
  const r = clusterProgressEventSchema.safeParse(DONE_EVENT)
  assert.equal(r.success, true, JSON.stringify(r.error?.issues))
})

test("accepts the worker's failed event", () => {
  const r = clusterProgressEventSchema.safeParse(FAILED_EVENT)
  assert.equal(r.success, true, JSON.stringify(r.error?.issues))
})

test("accepts a failed event without partialStats (fake cluster)", () => {
  const r = clusterProgressEventSchema.safeParse({ stage: "failed", error: "boom" })
  assert.equal(r.success, true, JSON.stringify(r.error?.issues))
})

test("accepts a running-stage event", () => {
  const r = clusterProgressEventSchema.safeParse(RUNNING_EVENT)
  assert.equal(r.success, true, JSON.stringify(r.error?.issues))
})

test("rejects an empty object", () => {
  assert.equal(clusterProgressEventSchema.safeParse({}).success, false)
})

test("rejects a done event without chunksWritten", () => {
  assert.equal(clusterProgressEventSchema.safeParse({ stage: "done", stats: {} }).success, false)
})

test("rejects a done event without stats", () => {
  assert.equal(clusterProgressEventSchema.safeParse({ stage: "done", chunksWritten: 1 }).success, false)
})

test("rejects an unknown stage", () => {
  assert.equal(
    clusterProgressEventSchema.safeParse({ stage: "upload", fraction: 0.1, counters: {} }).success,
    false,
  )
})

test("rejects a fraction outside [0, 1]", () => {
  assert.equal(
    clusterProgressEventSchema.safeParse({ ...RUNNING_EVENT, fraction: 1.5 }).success,
    false,
  )
})

test("rejects a negative chunksWritten", () => {
  assert.equal(
    clusterProgressEventSchema.safeParse({ ...DONE_EVENT, chunksWritten: -1 }).success,
    false,
  )
})
