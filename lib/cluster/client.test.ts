// lib/cluster/client.test.ts
// parseWorkerTimeoutMs — found bug B6 (feedback 2026-09-29, Track B): a set but
// invalid WORKER_RUNNER_TIMEOUT_MS used to fall back to the 30 s default in
// silence, so a typo ("30s", "-1") ran with a timeout nobody configured. Unset
// still means the documented default; set-but-invalid now throws.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseWorkerTimeoutMs } from "./client"

test("unset → the documented 30 s default", () => {
  assert.equal(parseWorkerTimeoutMs(undefined), 30_000)
})

test("blank → the documented 30 s default", () => {
  assert.equal(parseWorkerTimeoutMs("  "), 30_000)
})

test("a positive integer is used as is", () => {
  assert.equal(parseWorkerTimeoutMs("45000"), 45_000)
})

test("set but invalid throws instead of silently defaulting", () => {
  for (const raw of ["30s", "abc", "0", "-1", "1.5", "Infinity"]) {
    assert.throws(() => parseWorkerTimeoutMs(raw), /WORKER_RUNNER_TIMEOUT_MS/, raw)
  }
})

// ---------------------------------------------------------------------------
// ocrQualitySync error classification, against a stub worker on a random port
// ---------------------------------------------------------------------------

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { ClusterClient, refusedArks } from "./client"
import { CLUSTER_POLL } from "./contracts"
import {
  OCR_QUALITY_ARTIFACT_VERSION,
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  OcrSyncUnavailableError,
  readWorkerSyncAnswer,
  type WorkerSyncAnswer,
} from "./ocr-quality"

/** process.env stores strings: assigning undefined would store "undefined". */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

type StubReply = { status: number; body: string } | "stall-body"

async function withStubWorker(reply: StubReply, run: () => Promise<void>): Promise<void> {
  const server: Server = createServer((_req, res) => {
    if (reply === "stall-body") {
      res.writeHead(200, { "content-type": "application/json" })
      res.write('{"documents":')
      return // never ends: the body read must time out
    }
    res.writeHead(reply.status, { "content-type": "application/json" })
    res.end(reply.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const saved = { url: process.env.WORKER_RUNNER_URL, timeout: process.env.WORKER_RUNNER_TIMEOUT_MS }
  process.env.WORKER_RUNNER_URL = `http://127.0.0.1:${port}`
  process.env.WORKER_RUNNER_TIMEOUT_MS = "300"
  try {
    await run()
  } finally {
    restoreEnv("WORKER_RUNNER_URL", saved.url)
    restoreEnv("WORKER_RUNNER_TIMEOUT_MS", saved.timeout)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const ARK = "ark:/12148/bpt6k841545p"

test("ocrQualitySync: a valid answer is returned", async () => {
  await withStubWorker(
    { status: 200, body: JSON.stringify({ documents: [], building: [ARK], unavailable: [] }) },
    async () => {
      assert.deepEqual(await ClusterClient.ocrQualitySync([ARK]), {
        documents: [],
        building: [ARK],
        unavailable: [],
        incompatible: [],
        broken: [],
      })
    },
  )
})

for (const status of [500, 503, 404]) {
  test(`ocrQualitySync: ${status} → OcrSyncUnavailableError (nobody at fault)`, async () => {
    await withStubWorker({ status, body: "down" }, async () => {
      await assert.rejects(ClusterClient.ocrQualitySync([ARK]), OcrSyncUnavailableError)
    })
  })
}

test("ocrQualitySync: no worker listening → OcrSyncUnavailableError", async () => {
  const saved = process.env.WORKER_RUNNER_URL
  process.env.WORKER_RUNNER_URL = "http://127.0.0.1:1"
  try {
    await assert.rejects(ClusterClient.ocrQualitySync([ARK]), OcrSyncUnavailableError)
  } finally {
    restoreEnv("WORKER_RUNNER_URL", saved)
  }
})

test("ocrQualitySync: a 200 whose body is not JSON (truncated, a proxy page) → unavailable: the transport failed", async () => {
  await withStubWorker({ status: 200, body: "<html>oops</html>" }, async () => {
    await assert.rejects(ClusterClient.ocrQualitySync([ARK]), OcrSyncUnavailableError)
  })
})

test("ocrQualitySync: a body that stalls after the headers times out → unavailable", async () => {
  await withStubWorker("stall-body", async () => {
    await assert.rejects(ClusterClient.ocrQualitySync([ARK]), OcrSyncUnavailableError)
  })
})

for (const [label, reply, scope] of [
  ["a 400 naming arks[0]", { status: 400, body: '{"error":"arks[0]: bad"}' }, OCR_SYNC_FAULT_SCOPE.ARKS],
  ["a 400 that names no ARK (unknown key)", { status: 400, body: '{"error":"unknown keys: x"}' }, OCR_SYNC_FAULT_SCOPE.EXCHANGE],
  ["a 401", { status: 401, body: "no" }, OCR_SYNC_FAULT_SCOPE.EXCHANGE],
  ["a 413", { status: 413, body: '{"error":"body exceeds"}' }, OCR_SYNC_FAULT_SCOPE.EXCHANGE],
  ["a 200 missing a top-level key", { status: 200, body: '{"documents":[],"building":[]}' }, OCR_SYNC_FAULT_SCOPE.EXCHANGE],
  [
    "a 200 whose document has no integer `v` (the envelope does not parse)",
    { status: 200, body: JSON.stringify({ documents: [{ v: "2", ark: ARK }], building: [], unavailable: [] }) },
    OCR_SYNC_FAULT_SCOPE.EXCHANGE,
  ],
  [
    "a 200 answering an ARK twice",
    { status: 200, body: JSON.stringify({ documents: [], building: [ARK, ARK], unavailable: [] }) },
    OCR_SYNC_FAULT_SCOPE.EXCHANGE,
  ],
] as const) {
  test(`ocrQualitySync: ${label} → OcrSyncContractError on ${scope}`, async () => {
    await withStubWorker(reply, async () => {
      await assert.rejects(
        ClusterClient.ocrQualitySync([ARK]),
        (err: unknown) =>
          err instanceof OcrSyncContractError &&
          err.scope === scope &&
          (scope === OCR_SYNC_FAULT_SCOPE.ARKS ? err.culprits.join() === ARK : err.culprits.length === 0),
      )
    })
  })
}

test("ocrQualitySync: a caller's abort cancels the request", async () => {
  await withStubWorker("stall-body", async () => {
    const controller = new AbortController()
    const pending = ClusterClient.ocrQualitySync([ARK], controller.signal)
    controller.abort()
    await assert.rejects(pending, OcrSyncUnavailableError)
  })
})

test("refusedArks: a 400 naming arks[i] pins that ARK; anything else pins none", () => {
  assert.deepEqual(refusedArks([ARK], '{"error":"arks[0]: bad"}'), [ARK])
  assert.deepEqual(refusedArks([ARK], '{"error":"arks[3]: bad"}'), [], "an index outside the request")
  assert.deepEqual(refusedArks([ARK], '{"error":"unknown keys: x"}'), [])
  assert.deepEqual(refusedArks([ARK], "not json"), [])
})

// The two layers of an answer (readWorkerSyncAnswer): the envelope must parse;
// each document is then judged ALONE by its own `v`. No counting across
// documents: K1–K3 are the pass-5 probe's partial-skew cases.
const ARKS3 = ["ark:/12148/bpt6k1", "ark:/12148/bpt6k2", "ark:/12148/bpt6k3"] as const
const [K_A, K_B, K_C] = ARKS3
const BUILT_AT = new Date().toISOString()
const V = OCR_QUALITY_ARTIFACT_VERSION
const okFolio = (ordre: number) => ({ ordre, ocrSource: "alto", ocrQuality: 0.9, wordCount: 10 })
const okDoc = (ark: string, over: Record<string, unknown> = {}) => ({
  v: V,
  ark,
  ocrRate: 0.9,
  lane: "text",
  folios: [okFolio(1), okFolio(2)],
  builtAt: BUILT_AT,
  ...over,
})
const mistralV2Folio = (ordre: number) => ({ ordre, ocrSource: "mistral", ocrQuality: null, wordCount: 120 })

function read(raw: unknown): WorkerSyncAnswer {
  const result = readWorkerSyncAnswer(raw)
  if (!result.ok) throw new Error(`the envelope should parse: ${result.message}`)
  return result.answer
}

function verdicts(answer: WorkerSyncAnswer) {
  return {
    valid: answer.documents.map((d) => d.ark),
    incompatible: answer.incompatible.map((i) => `${i.ark}@v${i.v}`),
    broken: answer.broken.map((b) => b.ark),
  }
}

test("K1 partial rollout: a cached v1 artifact beside fresh v2 ones → v1 read, v2 incompatible, nobody broken", () => {
  const answer = read({
    documents: [okDoc(K_A), okDoc(K_B, { v: V + 1 }), okDoc(K_C, { v: V + 1 })],
    building: [],
    unavailable: [],
  })
  assert.deepEqual(verdicts(answer), {
    valid: [K_A],
    incompatible: [`${K_B}@v${V + 1}`, `${K_C}@v${V + 1}`],
    broken: [],
  })
})

test("K2 a contract change on the mistral lane only: the worker bumps `v` (the rule) → those ARKs incompatible, the text one read", () => {
  const changed = (ark: string) => okDoc(ark, { v: V + 1, lane: "mistral", folios: [mistralV2Folio(1)] })
  assert.deepEqual(
    verdicts(read({ documents: [okDoc(K_A), changed(K_B), changed(K_C)], building: [], unavailable: [] })),
    { valid: [K_A], incompatible: [`${K_B}@v${V + 1}`, `${K_C}@v${V + 1}`], broken: [] },
  )
})

test("K2 without the bump (the rule broken): the same documents are BROKEN — each rejected on its own, the text one still read", () => {
  const changed = (ark: string) => okDoc(ark, { lane: "mistral", folios: [mistralV2Folio(1)] })
  assert.deepEqual(
    verdicts(read({ documents: [okDoc(K_A), changed(K_B), changed(K_C)], building: [], unavailable: [] })),
    { valid: [K_A], incompatible: [], broken: [K_B, K_C] },
  )
})

test("K3 ocrRate rescaled to a percentage: bumped `v` → every artifact of the new version is incompatible, the null-rate one included", () => {
  const answer = read({
    documents: [
      okDoc(K_A, { v: V + 1, ocrRate: null }),
      okDoc(K_B, { v: V + 1, ocrRate: 93 }),
      okDoc(K_C, { v: V + 1, ocrRate: 88 }),
    ],
    building: [],
    unavailable: [],
  })
  assert.deepEqual(verdicts(answer).incompatible, [`${K_A}@v${V + 1}`, `${K_B}@v${V + 1}`, `${K_C}@v${V + 1}`])
  assert.deepEqual(answer.documents, [], "a null-rate document of the new version is NOT read with the old meaning")
})

test("a broken artifact of the expected version (a duplicate folio) is that ARK's alone, even as the only document", () => {
  const answer = read({ documents: [okDoc(K_A, { folios: [okFolio(1), okFolio(1)] })], building: [], unavailable: [] })
  assert.deepEqual(verdicts(answer), { valid: [], incompatible: [], broken: [K_A] })
  assert.match(answer.broken[0]?.message ?? "", /duplicate folio/)
})

test("buildings and unavailables are read as they are beside an incompatible document", () => {
  const answer = read({
    documents: [okDoc(K_A, { v: V + 1 })],
    building: [K_B],
    unavailable: [{ ark: K_C, reason: "no_pages_artifact" }],
  })
  assert.deepEqual(answer.building, [K_B])
  assert.deepEqual(answer.unavailable, [{ ark: K_C, reason: "no_pages_artifact" }])
})

test("the envelope: a missing bucket, an empty reason, an ARK in two buckets → not an answer", () => {
  for (const raw of [
    { documents: [], building: [] },
    { documents: [], building: [], unavailable: [{ ark: K_A, reason: "" }] },
    { documents: [okDoc(K_A)], building: [K_A], unavailable: [] },
    { documents: [{ ark: K_A }], building: [], unavailable: [] },
  ]) {
    assert.equal(readWorkerSyncAnswer(raw).ok, false, JSON.stringify(raw))
  }
})

// ---------------------------------------------------------------------------
// progress(): four outcomes, never "run gone" for an outage
// ---------------------------------------------------------------------------

const READ_MODEL = {
  docs: { done: 1 },
  docsTotal: 1,
  docsFinished: 1,
  stages: {},
  folios: { expected: 1, done: 1, failed: 0 },
  fetchRatePerMin: 1000,
  manifestRatePerMin: 42,
  etaSeconds: null,
  reconciles: true,
}

test("progress: a read-model → progress", async () => {
  await withStubWorker({ status: 200, body: JSON.stringify(READ_MODEL) }, async () => {
    const poll = await ClusterClient.progress("run-1")
    assert.equal(poll.kind, CLUSTER_POLL.PROGRESS)
  })
})

test("progress: 404 → run_unknown; 503 → worker_error", async () => {
  await withStubWorker({ status: 404, body: "" }, async () => {
    assert.deepEqual(await ClusterClient.progress("run-1"), { kind: CLUSTER_POLL.RUN_UNKNOWN })
  })
  await withStubWorker({ status: 503, body: "busy" }, async () => {
    assert.deepEqual(await ClusterClient.progress("run-1"), { kind: CLUSTER_POLL.WORKER_ERROR, status: 503 })
  })
})

test("progress: no worker listening → worker_unreachable", async () => {
  const saved = process.env.WORKER_RUNNER_URL
  process.env.WORKER_RUNNER_URL = "http://127.0.0.1:1"
  try {
    const poll = await ClusterClient.progress("run-1")
    assert.equal(poll.kind, CLUSTER_POLL.WORKER_UNREACHABLE)
  } finally {
    restoreEnv("WORKER_RUNNER_URL", saved)
  }
})

test("progress: a 200 that is not a read-model is a contract break and throws", async () => {
  await withStubWorker({ status: 200, body: '{"docs":"nope"}' }, async () => {
    await assert.rejects(ClusterClient.progress("run-1"), /invalid worker read-model/)
  })
})
