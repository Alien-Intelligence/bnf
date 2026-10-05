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

import { ClusterClient, culpritsOf } from "./client"
import { CLUSTER_POLL } from "./contracts"
import {
  OCR_SYNC_FAULT_SCOPE,
  OcrSyncContractError,
  OcrSyncUnavailableError,
  workerOcrQualitySyncResponseSchema,
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
  ["a non-JSON 200", { status: 200, body: "<html>oops</html>" }, OCR_SYNC_FAULT_SCOPE.EXCHANGE],
  ["a 200 missing a top-level key", { status: 200, body: '{"documents":[],"building":[]}' }, OCR_SYNC_FAULT_SCOPE.EXCHANGE],
  [
    "a 200 whose only document is invalid (no document passed: skew)",
    { status: 200, body: JSON.stringify({ documents: [{ v: 2, ark: ARK }], building: [], unavailable: [] }) },
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

test("culpritsOf: an invalid entry outside the asked ARKs is the exchange's fault", () => {
  assert.deepEqual(
    culpritsOf([ARK], {
      kind: "invalid",
      raw: { documents: [{ ark: "ark:/12148/other" }] },
      issuePaths: [["documents", 0, "v"]],
    }),
    [],
  )
})

// Version skew (pass-4 probe cases A–E): if NO returned document passes, the
// exchange is broken — pause, blame nobody; per-ARK only when one passed.
const SKEW_ARKS = ["ark:/12148/bpt6k1", "ark:/12148/bpt6k2", "ark:/12148/bpt6k3"]
const BUILT_AT = new Date().toISOString()
const okFolio = (ordre: number) => ({ ordre, ocrSource: "alto", ocrQuality: 0.9, wordCount: 10 })
const okDoc = (ark: string) => ({ v: 1, ark, ocrRate: 0.9, lane: "text", folios: [okFolio(1)], builtAt: BUILT_AT })

function culpritsFor(raw: Record<string, unknown>, asked: string[] = SKEW_ARKS): string[] {
  const parsed = workerOcrQualitySyncResponseSchema.safeParse(raw)
  assert.equal(parsed.success, false, "the probe answer must be invalid")
  const issuePaths = parsed.success ? [] : parsed.error.issues.map((i) => i.path)
  return culpritsOf(asked, { kind: "invalid", raw, issuePaths })
}

test("skew A: v:2 on every document → the exchange's fault", () => {
  assert.deepEqual(
    culpritsFor({ documents: SKEW_ARKS.map((ark) => ({ ...okDoc(ark), v: 2 })), building: [], unavailable: [] }),
    [],
  )
})

test("skew B: v:2 on the ONLY document of a mixed batch → the exchange's fault (no document passed)", () => {
  assert.deepEqual(
    culpritsFor({ documents: [{ ...okDoc(SKEW_ARKS[0]), v: 2 }], building: SKEW_ARKS.slice(1), unavailable: [] }),
    [],
  )
})

test("skew C: a renamed folio field on every folio of every document → the exchange's fault", () => {
  const renamed = (ark: string) => ({
    ...okDoc(ark),
    folios: [1, 2].map((o) => {
      const { wordCount, ...rest } = okFolio(o)
      return { ...rest, words: wordCount }
    }),
  })
  assert.deepEqual(culpritsFor({ documents: SKEW_ARKS.map(renamed), building: [], unavailable: [] }), [])
})

test("skew D: v:2 AND a renamed top-level field on every document → the exchange's fault", () => {
  const skewed = (ark: string) => {
    const { ocrRate, ...rest } = okDoc(ark)
    return { ...rest, v: 2, rate: ocrRate }
  }
  assert.deepEqual(culpritsFor({ documents: SKEW_ARKS.map(skewed), building: [], unavailable: [] }), [])
})

test("skew E: a single-ARK batch whose one document fails → the exchange's fault", () => {
  assert.deepEqual(
    culpritsFor({ documents: [{ ...okDoc(SKEW_ARKS[0]), v: 2 }], building: [], unavailable: [] }, [SKEW_ARKS[0]]),
    [],
  )
})

test("one bad document while another in the same answer passed → that ARK blamed", () => {
  assert.deepEqual(
    culpritsFor({
      documents: [{ ...okDoc(SKEW_ARKS[0]), v: 2 }, okDoc(SKEW_ARKS[1])],
      building: [SKEW_ARKS[2]],
      unavailable: [],
    }),
    [SKEW_ARKS[0]],
  )
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
