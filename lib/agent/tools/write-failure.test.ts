// lib/agent/tools/write-failure.test.ts
// A failed corpus write is a structured SYSTEM failure the model cannot read as
// a size limit. Prod, 2026-10-27: buffer_commit hit a Prisma P2028 transaction
// timeout, the SDK handed the model `Tool "buffer_commit" failed: Transaction
// API error … 5006 ms passed`, and the agent invented a "~500 documents" cap,
// discarded ~10 000 candidates and proposed lots of 10.
//
// Each corpus-advancing handler is called directly with its service forced to
// throw: a Prisma request error with code P2028 and a generic error. Nothing may
// throw out of the tool, the result is `success: false` with a stable code and a
// `retryable` flag, the real error is logged, and the persisted status is the
// failure status (toolCallErrored — the same predicate the persistence adapter
// uses).
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import { Prisma, type Project, type User } from "@/lib/generated/prisma/client"
import { createTestUser, createTestProject, createTestSession, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { toolCallErrored } from "@/lib/tools/display"
import { BufferQueries } from "@/models/buffer/queries"
import { BUFFER_STATUS } from "@/models/buffer/schema"
import { BufferService } from "@/models/buffer/service"
import { CorpusService } from "@/models/corpus/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import type { PolicyUser } from "@/models/users/schema"
import { bufferAddTool, bufferClearTool, bufferCommitTool, bufferDiscardTool, bufferRemoveByFilterTool } from "./buffer"
import { AGENT_TOOLS } from "./constants"
import { corpusAddTool, corpusRemoveByFilterTool, corpusRemoveTool } from "./corpus"
import { SYSTEM_FAILURE_CODE } from "./failure"
import type { TurnScopedCtx } from "./registry-factory"

const ARK = "ark:/12148/bpt6k2839841"

let ownerRow: User
let owner: PolicyUser
let project: Project
let corpusSession: string

function ctx(): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    db: prisma,
    user: owner,
    appSessionId: corpusSession,
    projectId: project.id,
    corpusProjectId: project.id,
    corpusReachable: true,
    scope: SESSION_SCOPE.CORPUS,
  }
}

before(async () => {
  ownerRow = await createTestUser()
  owner = { ...ownerRow, groupIds: [] }
  project = await createTestProject(ownerRow.id, "write-failure")
  corpusSession = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(ownerRow.id)
})

/** What Prisma throws when an interactive transaction outlives its timeout. */
function transactionTimeout(): Error {
  return new Prisma.PrismaClientKnownRequestError(
    "Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this " +
      "transaction was 5000 ms, however 5006 ms passed since the start of the transaction.",
    { code: "P2028", clientVersion: "test" },
  )
}

type Failing = { name: string; arm: (t: import("node:test").TestContext, err: Error) => void; call: () => unknown }

const TOOLS: readonly Failing[] = [
  {
    name: AGENT_TOOLS.bufferCommit,
    arm: (t, err) => {
      t.mock.method(BufferService, "commit", async () => {
        throw err
      })
    },
    call: () => bufferCommitTool.handler({ reason: "test" }, ctx()),
  },
  {
    name: AGENT_TOOLS.bufferDiscard,
    arm: (t, err) => {
      t.mock.method(BufferService, "discard", async () => {
        throw err
      })
    },
    call: () => bufferDiscardTool.handler({ arks: [ARK] }, ctx()),
  },
  {
    name: AGENT_TOOLS.bufferClear,
    arm: (t, err) => {
      t.mock.method(BufferService, "clear", async () => {
        throw err
      })
    },
    call: () => bufferClearTool.handler({}, ctx()),
  },
  {
    name: AGENT_TOOLS.bufferAdd,
    arm: (t, err) => {
      t.mock.method(BufferService, "registerCandidates", async () => {
        throw err
      })
    },
    call: () => bufferAddTool.handler({ arks: [ARK] }, ctx()),
  },
  {
    name: AGENT_TOOLS.bufferRemoveByFilter,
    arm: (t, err) => {
      t.mock.method(BufferService, "removeByFilter", async () => {
        throw err
      })
    },
    call: () => bufferRemoveByFilterTool.handler({ filters: { lang: ["fr"] }, dry_run: false }, ctx()),
  },
  {
    name: AGENT_TOOLS.corpusAdd,
    arm: (t, err) => {
      t.mock.method(CorpusService, "addArks", async () => {
        throw err
      })
    },
    call: () => corpusAddTool.handler({ arks: [ARK], reason: "test" }, ctx()),
  },
  {
    name: AGENT_TOOLS.corpusRemove,
    arm: (t, err) => {
      t.mock.method(CorpusService, "removeArks", async () => {
        throw err
      })
    },
    call: () => corpusRemoveTool.handler({ arks: [ARK], reason: "test" }, ctx()),
  },
  {
    name: AGENT_TOOLS.corpusRemoveByFilter,
    arm: (t, err) => {
      t.mock.method(CorpusService, "removeByFilter", async () => {
        throw err
      })
    },
    call: () => corpusRemoveByFilterTool.handler({ filters: { yearFrom: 1970 }, reason: "test", dry_run: false }, ctx()),
  },
]

for (const tool of TOOLS) {
  test(`${tool.name}: a P2028 transaction timeout is a retryable system failure, not a throw`, async (t) => {
    const logged = t.mock.method(console, "error", () => undefined)
    tool.arm(t, transactionTimeout())

    const result = await tool.call()

    assert.ok(typeof result === "object" && result !== null)
    const r = result as Record<string, unknown>
    assert.equal(r.success, false)
    assert.equal(r.code, SYSTEM_FAILURE_CODE.TRANSACTION_TIMEOUT)
    assert.equal(r.retryable, true)
    assert.match(String(r.error), /ÉCHEC SYSTÈME/)
    assert.match(String(r.error), /PAS une limite de taille/)
    assert.match(String(r.error), /AUCUN candidat/)
    assert.match(String(r.error), /MÊME appel à l'identique/, "retryable: propose the identical retry")
    assert.doesNotMatch(String(r.error), /5006|P2028|expired transaction/, "the raw Prisma text never reaches the model")
    assert.equal(toolCallErrored(false, JSON.stringify(result)), true, "persisted as a failure, not ✓")
    assert.equal(logged.mock.callCount(), 1, "the real error is logged server-side")
    assert.match(String(logged.mock.calls[0]?.arguments[0]), new RegExp(tool.name))
    assert.equal((logged.mock.calls[0]?.arguments[1] as Error).message.includes("5006 ms"), true)
  })

  test(`${tool.name}: a generic error is a non-retryable system failure, not a throw`, async (t) => {
    const logged = t.mock.method(console, "error", () => undefined)
    tool.arm(t, new Error("connection reset by peer"))

    const result = await tool.call()

    assert.ok(typeof result === "object" && result !== null)
    const r = result as Record<string, unknown>
    assert.equal(r.success, false)
    assert.equal(r.code, SYSTEM_FAILURE_CODE.SYSTEM_ERROR)
    assert.equal(r.retryable, false)
    assert.match(String(r.error), /PAS une limite de taille/)
    assert.match(String(r.error), /arrête-toi/, "not retryable: report and stop")
    assert.doesNotMatch(String(r.error), /MÊME appel/)
    assert.doesNotMatch(String(r.error), /connection reset/)
    assert.equal(toolCallErrored(false, JSON.stringify(result)), true)
    assert.equal(logged.mock.callCount(), 1)
  })
}

test("buffer_commit: a failure AFTER addArks is safe to re-run — the commit is idempotent", async (t) => {
  const arks = [ARK, "ark:/12148/bpt6k2839842"]
  await prisma.bufferItem.createMany({
    data: arks.map((ark) => ({ projectId: project.id, ark, originTool: AGENT_TOOLS.bufferAdd, status: BUFFER_STATUS.CANDIDATE })),
  })
  t.mock.method(console, "error", () => undefined)
  const failOnce = t.mock.method(BufferQueries, "markCommitted", async () => {
    throw new Error("connection reset by peer")
  })

  const failed = (await bufferCommitTool.handler({ reason: "test" }, ctx())) as Record<string, unknown>

  assert.equal(failed.success, false)
  assert.match(String(failed.error), /idempotente/)
  assert.doesNotMatch(String(failed.error), /intact/, "never claims the buffer is untouched")
  const afterFailure = await prisma.bufferItem.findMany({ where: { projectId: project.id, ark: { in: arks } } })
  assert.ok(afterFailure.every((r) => r.status === BUFFER_STATUS.CANDIDATE), "no row discarded or removed by the failure")

  failOnce.mock.restore()
  // The identical re-run (the service, not the tool: the tool would kick a background BnF resolve).
  const rerun = await BufferService.commit(project, ownerRow, { sessionId: corpusSession, reason: "test" })

  assert.equal(rerun.duplicates, arks.length, "the ARKs the failed run already versed count as duplicates")
  const head = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { headVersionId: true } })
  assert.ok(head.headVersionId, "the commit moved the project to a head version")
  const members = await prisma.corpusMembership.findMany({ where: { versionId: head.headVersionId } })
  assert.deepEqual(members.map((m) => m.ark).sort(), [...arks].sort(), "each ARK is in the head exactly once")
  const rows = await prisma.bufferItem.findMany({ where: { projectId: project.id, ark: { in: arks } } })
  assert.ok(rows.every((r) => r.status === BUFFER_STATUS.COMMITTED), "every row ends committed")
})

test("buffer_add: a failure AFTER the insert is safe to re-run — each ARK is staged once, nothing discarded", async (t) => {
  const arks = ["ark:/12148/bpt6k2839851", "ark:/12148/bpt6k2839852"]
  t.mock.method(console, "error", () => undefined)
  const failOnce = t.mock.method(BufferQueries, "applyRegistration", async () => {
    throw new Error("connection reset by peer")
  })

  const failed = (await bufferAddTool.handler({ arks }, ctx())) as Record<string, unknown>

  assert.equal(failed.success, false)
  assert.match(String(failed.error), /à l'identique est sans risque/)
  assert.doesNotMatch(String(failed.error), /inchangé/, "never claims the buffer is untouched")
  const afterFailure = await prisma.bufferItem.findMany({ where: { projectId: project.id, ark: { in: arks } } })
  assert.ok(afterFailure.every((r) => r.status !== BUFFER_STATUS.DISCARDED), "the failure discarded nothing")

  failOnce.mock.restore()
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: AGENT_TOOLS.bufferAdd,
    restageDiscarded: true,
    candidates: arks.map((ark) => ({ ark })),
  })

  const rows = await prisma.bufferItem.findMany({ where: { projectId: project.id, ark: { in: arks } } })
  assert.deepEqual(rows.map((r) => r.ark).sort(), [...arks].sort(), "each ARK is staged exactly once")
  assert.ok(rows.every((r) => r.status === BUFFER_STATUS.CANDIDATE))
})
