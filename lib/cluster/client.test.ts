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

import { ClusterClient } from "./client"
import { OcrSyncContractError, OcrSyncUnavailableError } from "./ocr-quality"

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

for (const [label, reply] of [
  ["a 400 refusing the batch", { status: 400, body: '{"error":"arks[0]: bad"}' }],
  ["a non-JSON 200", { status: 200, body: "<html>oops</html>" }],
  ["a 200 outside the schema", { status: 200, body: '{"documents":[{"v":2}],"building":[],"unavailable":[]}' }],
] as const) {
  test(`ocrQualitySync: ${label} → OcrSyncContractError`, async () => {
    await withStubWorker(reply, async () => {
      await assert.rejects(ClusterClient.ocrQualitySync([ARK]), OcrSyncContractError)
    })
  })
}
