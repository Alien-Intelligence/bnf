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
import { BufferService } from "@/models/buffer/service"
import { CorpusService } from "@/models/corpus/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import type { PolicyUser } from "@/models/users/schema"
import { bufferCommitTool } from "./buffer"
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
    name: "buffer_commit",
    arm: (t, err) => {
      t.mock.method(BufferService, "commit", async () => {
        throw err
      })
    },
    call: () => bufferCommitTool.handler({ reason: "test" }, ctx()),
  },
  {
    name: "corpus_add",
    arm: (t, err) => {
      t.mock.method(CorpusService, "addArks", async () => {
        throw err
      })
    },
    call: () => corpusAddTool.handler({ arks: [ARK], reason: "test" }, ctx()),
  },
  {
    name: "corpus_remove",
    arm: (t, err) => {
      t.mock.method(CorpusService, "removeArks", async () => {
        throw err
      })
    },
    call: () => corpusRemoveTool.handler({ arks: [ARK], reason: "test" }, ctx()),
  },
  {
    name: "corpus_remove_by_filter",
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
    assert.doesNotMatch(String(r.error), /connection reset/)
    assert.equal(toolCallErrored(false, JSON.stringify(result)), true)
    assert.equal(logged.mock.callCount(), 1)
  })
}
