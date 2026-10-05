// lib/agent/tools/spawn.test.ts
// Deterministic (no-LLM) guards for the spawn_research sub-agent. The full
// handler runs a real child runner and is exercised by the real-agent e2e; here
// we lock the SAFETY INVARIANTS that must hold regardless of the model: a child
// can never recurse, can never reach a destructive tool by default, and the
// tool is registered in both scopes. A regression in any of these is a security
// / cost problem, so it belongs in the millisecond gate.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { childPool, defaultAllowlist } from "./spawn"
import { toolsForScope } from "./index"
import { AGENT_TOOLS } from "./constants"

const SCOPES = ["corpus", "research"] as const

test("spawn_research is registered in BOTH scopes (delegation available everywhere)", () => {
  for (const scope of SCOPES) {
    const names = toolsForScope(scope).map((t) => t.name)
    assert.ok(names.includes(AGENT_TOOLS.spawnResearch), `${scope} scope has spawn_research`)
  }
})

test("the child pool NEVER contains spawn_research (no recursion)", () => {
  for (const scope of SCOPES) {
    const names = childPool(scope).map((t) => t.name)
    assert.ok(
      !names.includes(AGENT_TOOLS.spawnResearch),
      `${scope} child pool must exclude spawn_research`,
    )
  }
})

test("the default allow-list is a subset of the scope's child pool", () => {
  for (const scope of SCOPES) {
    const pool = new Set(childPool(scope).map((t) => t.name))
    for (const name of defaultAllowlist(scope)) {
      assert.ok(pool.has(name), `${scope} default allow-list tool ${name} is in the pool`)
    }
  }
})

test("the default allow-list grants NO destructive / commit tools", () => {
  // A sub-agent gathers; the parent decides. Committing the corpus, clearing the
  // buffer, or writing project memory must never be in the default child set.
  const forbidden = new Set<string>([
    AGENT_TOOLS.bufferCommit,
    AGENT_TOOLS.bufferClear,
    AGENT_TOOLS.bufferRemoveByFilter,
    AGENT_TOOLS.corpusAdd,
    AGENT_TOOLS.corpusRemove,
    AGENT_TOOLS.corpusRemoveByFilter,
    AGENT_TOOLS.memoryWrite,
    AGENT_TOOLS.noteCreate,
    AGENT_TOOLS.noteUpdate,
    AGENT_TOOLS.noteAppend,
    AGENT_TOOLS.ingestSubmit,
  ])
  for (const scope of SCOPES) {
    const leaked = defaultAllowlist(scope).filter((n) => forbidden.has(n))
    assert.deepEqual(leaked, [], `${scope} default allow-list leaks destructive tools: ${leaked.join(", ")}`)
  }
})

test("the child POOL itself grants no destructive / commit / write tool (the description's promise)", () => {
  const forbidden = new Set<string>([
    AGENT_TOOLS.bufferCommit,
    AGENT_TOOLS.bufferClear,
    AGENT_TOOLS.bufferDiscard,
    AGENT_TOOLS.bufferRemoveByFilter,
    AGENT_TOOLS.corpusAdd,
    AGENT_TOOLS.corpusRemove,
    AGENT_TOOLS.corpusRemoveByFilter,
    AGENT_TOOLS.memoryWrite,
    AGENT_TOOLS.ingestSubmit,
    AGENT_TOOLS.spawnResearch,
  ])
  for (const scope of SCOPES) {
    const leaked = childPool(scope)
      .map((t) => t.name)
      .filter((n) => forbidden.has(n))
    assert.deepEqual(leaked, [], `${scope} child pool leaks: ${leaked.join(", ")}`)
  }
})

test("corpus child default can search + stage; research child default can read RAG", () => {
  assert.ok(defaultAllowlist("corpus").includes(AGENT_TOOLS.corpusSearch), "corpus child can search")
  assert.ok(defaultAllowlist("corpus").includes(AGENT_TOOLS.bufferAdd), "corpus child can stage")
  assert.ok(defaultAllowlist("research").includes(AGENT_TOOLS.ragQuery), "research child can query RAG")
})

// ---------------------------------------------------------------------------
// Fan-out caps (incident 2026-09-30): session b275569f… ran 7 children in
// parallel and d1073498… ran 17 in one session, all sharing one BnF quota. The
// caps are enforced in runSpawn with injected deps, so they are tested with a
// fake runner and no LLM. DB-backed for the per-session count, which is durable
// (app_session.spawn_runs, claimed atomically per run), so a reload cannot reset
// it and a refusal never counts.
// ---------------------------------------------------------------------------

import { before, after } from "node:test"
import { randomUUID } from "node:crypto"
import type { ChatEvent } from "@alien/chat-sdk/events"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { SPAWN_MAX_CONCURRENT_PER_TURN, SPAWN_MAX_PER_SESSION } from "@/lib/constants"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { SessionQueries, type SpawnClaim } from "@/models/sessions/queries"
import {
  createTestProject,
  createTestSession,
  createTestUser,
  deleteTestUser,
} from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { runSpawn, type SpawnDeps, type SpawnFailure, type SpawnRunner } from "./spawn"
import type { TurnScopedCtx } from "./registry-factory"
import { SPAWN_LIMIT_REFUSAL } from "./failure"

let user: User
let project: Project

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "spawn caps")
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

type Emitted = { type: string; data: unknown }

function makeCtx(appSessionId: string, emitted: Emitted[]): TurnScopedCtx {
  return {
    signal: new AbortController().signal,
    request: new Request("http://localhost/test"),
    emit: (e) => emitted.push(e),
    db: prisma,
    user: { ...user, groupIds: [] },
    appSessionId,
    projectId: project.id,
    corpusProjectId: project.id,
    corpusReachable: true,
    scope: "corpus",
  }
}

/** Omit that distributes over a union, so each ChatEvent variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function stamp(e: DistributiveOmit<ChatEvent, "at">): ChatEvent {
  return { at: Date.now(), ...e }
}

function deps(runner: SpawnRunner, timeoutMs = 5_000, overrides: Partial<SpawnDeps> = {}): SpawnDeps {
  return {
    runner,
    timeoutMs,
    buildSystem: async () => "SYSTEM",
    resolveMcpServers: async () => [],
    claimRun: (appSessionId) => SessionQueries.claimSpawnRun(appSessionId, SPAWN_MAX_PER_SESSION),
    releaseRun: (appSessionId) => SessionQueries.releaseSpawnRun(appSessionId),
    ...overrides,
  }
}

/** A promise that never settles — a hung database or provider call. */
const hang = <T,>(): Promise<T> => new Promise<T>(() => undefined)

async function spawnRuns(appSessionId: string): Promise<number> {
  return (await prisma.appSession.findUniqueOrThrow({ where: { id: appSessionId } })).spawnRuns
}

test("at most SPAWN_MAX_CONCURRENT_PER_TURN children run at once; the extra one is refused without a subagent_event", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const emitted: Emitted[] = []
  const ctx = makeCtx(sid, emitted)

  const { promise: released, resolve: release } = Promise.withResolvers<void>()
  let started = 0
  const runner: SpawnRunner = async function* () {
    started += 1
    await released
    yield stamp({ type: "text-delta", text: "fini" })
  }

  const launches = SPAWN_MAX_CONCURRENT_PER_TURN + 1
  const runs = Array.from({ length: launches }, () =>
    runSpawn({ task: "balaie" }, ctx, deps(runner)),
  )
  // Let every launch pass its cap check before releasing the children.
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const results = await Promise.all(runs)

  const refused = results.filter(
    (r): r is SpawnFailure => "refused" in r && r.refused === SPAWN_LIMIT_REFUSAL,
  )
  assert.equal(refused.length, 1, "exactly one launch over the cap is refused")
  assert.equal(refused[0].success, false, "a refusal is marked as a failure for the chip")
  assert.match(String(refused[0].error), /sous-agents en cours/)
  assert.equal(started, SPAWN_MAX_CONCURRENT_PER_TURN, "the others all ran")
  const starts = emitted.filter((e) => e.type === "subagent_event" && (e.data as { kind: string }).kind === "start")
  assert.equal(starts.length, SPAWN_MAX_CONCURRENT_PER_TURN, "no start event for the refused spawn")
  assert.equal(await spawnRuns(sid), SPAWN_MAX_CONCURRENT_PER_TURN, "the refused launch is not counted as a run")
})

test("the durable per-session count refuses the spawn once SPAWN_MAX_PER_SESSION runs were made", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  await prisma.appSession.update({ where: { id: sid }, data: { spawnRuns: SPAWN_MAX_PER_SESSION } })
  const emitted: Emitted[] = []
  let started = 0
  const runner: SpawnRunner = async function* () {
    started += 1
    yield stamp({ type: "text-delta", text: "fini" })
  }
  const result = await runSpawn({ task: "balaie" }, makeCtx(sid, emitted), deps(runner))
  assert.ok("refused" in result && result.refused === SPAWN_LIMIT_REFUSAL)
  assert.match(result.error, /par session/)
  assert.equal(started, 0)
  assert.equal(emitted.length, 0)
  assert.equal(await spawnRuns(sid), SPAWN_MAX_PER_SESSION, "a refusal is not a run")
})

test("the last run of the session still runs, and is counted", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  await prisma.appSession.update({ where: { id: sid }, data: { spawnRuns: SPAWN_MAX_PER_SESSION - 1 } })
  let started = 0
  const runner: SpawnRunner = async function* () {
    started += 1
    yield stamp({ type: "text-delta", text: "fini" })
  }
  const result = await runSpawn({ task: "balaie" }, makeCtx(sid, []), deps(runner))
  assert.equal("summary" in result && result.summary, "fini")
  assert.equal(started, 1)
  assert.equal(await spawnRuns(sid), SPAWN_MAX_PER_SESSION)
})

test("a hung session cap check is bounded: it ends at the ceiling, emits nothing, frees its slot", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const emitted: Emitted[] = []
  const result = await runSpawn(
    { task: "balaie" },
    makeCtx(sid, emitted),
    deps(waitsForAbort, 20, { claimRun: () => hang<SpawnClaim>() }),
  )
  assert.ok("success" in result && result.success === false)
  assert.match(String("error" in result ? result.error : ""), /délai/)
  assert.equal(emitted.length, 0, "no run was admitted, so no start row")
  // The slot came back: a full set of concurrent runs is admitted afterwards.
  const ok = await runSpawn({ task: "balaie" }, makeCtx(sid, []), deps(async function* () {
    yield stamp({ type: "text-delta", text: "fini" })
  }))
  assert.equal("summary" in ok && ok.summary, "fini")
})

for (const [what, overrides] of [
  ["prompt build", { buildSystem: () => hang<string>() }],
  ["MCP resolve", { resolveMcpServers: () => hang<never[]>() }],
] as const) {
  test(`a hung ${what} is bounded: one start, one timeout`, async () => {
    const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
    const emitted: Emitted[] = []
    const result = await runSpawn({ task: "balaie" }, makeCtx(sid, emitted), deps(waitsForAbort, 20, overrides))
    assert.ok("success" in result && result.success === false)
    assertPaired(emitted, "timeout")
  })
}

test("a child that staged then timed out still reports what it staged", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const emitted: Emitted[] = []
  const stagesThenHangs: SpawnRunner = async function* ({ toolContext, signal }) {
    if (toolContext.stagingTally) toolContext.stagingTally.added += 7
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
    yield stamp({ type: "text-delta", text: "jamais" })
  }
  const result = await runSpawn({ task: "balaie" }, makeCtx(sid, emitted), deps(stagesThenHangs, 20))
  assert.ok("success" in result && result.success === false)
  assert.equal("buffered_added" in result && result.buffered_added, 7)
  assert.equal(assertPaired(emitted, "timeout").buffered, 7)
})

test("a slot is freed when the run ends, even when the runner throws", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const ctx = makeCtx(sid, [])
  const throwing: SpawnRunner = async function* () {
    yield stamp({ type: "text-delta", text: "" })
    throw new Error("boom")
  }
  const failed = await runSpawn({ task: "balaie" }, ctx, deps(throwing))
  assert.ok("success" in failed && failed.success === false)
  assert.match(failed.error, /boom/)

  // Fill the cap with blocked children, then confirm the slot the failed run
  // held is not leaked: exactly SPAWN_MAX_CONCURRENT_PER_TURN run.
  const { promise: released, resolve: release } = Promise.withResolvers<void>()
  let started = 0
  const blocking: SpawnRunner = async function* () {
    started += 1
    await released
    yield stamp({ type: "text-delta", text: "ok" })
  }
  const runs = Array.from({ length: SPAWN_MAX_CONCURRENT_PER_TURN }, () =>
    runSpawn({ task: "balaie" }, ctx, deps(blocking)),
  )
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const results = await Promise.all(runs)
  assert.equal(started, SPAWN_MAX_CONCURRENT_PER_TURN)
  assert.ok(results.every((r) => !("refused" in r)), "no refusal: the thrown run released its slot")
})

// ---------------------------------------------------------------------------
// Terminal events and per-run tallies (Track E Phase 10, feedback #10e). Every
// run has a runId; its start event is paired with EXACTLY ONE terminal event
// (done / error / timeout / aborted) on every path, and its `buffered` count
// is what THIS child staged, not a project-wide candidate delta.
// ---------------------------------------------------------------------------

type SubagentData = { kind: string; runId?: string; label?: string; toolCalls?: number; buffered?: number }

function subagentEvents(emitted: Emitted[]): SubagentData[] {
  return emitted.filter((e) => e.type === "subagent_event").map((e) => e.data as SubagentData)
}

/** Exactly one start and one terminal event, sharing one runId. */
function assertPaired(emitted: Emitted[], terminalKind: string): SubagentData {
  const events = subagentEvents(emitted)
  assert.equal(events.length, 2, `two subagent events, got ${JSON.stringify(events)}`)
  const [s, t] = events
  assert.equal(s.kind, "start")
  assert.equal(t.kind, terminalKind)
  assert.equal(typeof s.runId, "string")
  assert.equal(t.runId, s.runId, "start and terminal share the runId")
  return t
}

/** A runner that waits for its abort signal, then fails like an aborted fetch. */
const waitsForAbort: SpawnRunner = async function* ({ signal }) {
  await new Promise<void>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
  yield stamp({ type: "text-delta", text: "jamais" })
}

test("a runner that throws emits one start and one error with the same runId, and fails red", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const emitted: Emitted[] = []
  const throwing: SpawnRunner = async function* () {
    yield stamp({ type: "text-delta", text: "" })
    throw new Error("boom")
  }
  const result = await runSpawn({ task: "balaie la presse" }, makeCtx(sid, emitted), deps(throwing))
  assert.ok("success" in result && result.success === false)
  const t = assertPaired(emitted, "error")
  assert.equal(subagentEvents(emitted)[0].label, "balaie la presse", "the start row carries the task excerpt")
  assert.equal(typeof t.toolCalls, "number")
})

test("a runner that never yields hits the timeout: one timeout event", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const emitted: Emitted[] = []
  const result = await runSpawn({ task: "balaie" }, makeCtx(sid, emitted), deps(waitsForAbort, 20))
  assert.ok("success" in result && result.success === false)
  assert.match(String("error" in result ? result.error : ""), /délai/)
  assertPaired(emitted, "timeout")
})

test("a parent abort ends the child with one aborted event", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const emitted: Emitted[] = []
  const controller = new AbortController()
  // Abort once the run is admitted (its start row is out): an abort during the
  // cap check ends the launch before it starts, with no row at all.
  const { promise: startedRun, resolve: onStart } = Promise.withResolvers<void>()
  const ctx: TurnScopedCtx = {
    ...makeCtx(sid, emitted),
    signal: controller.signal,
    emit: (e) => {
      emitted.push(e)
      if (e.type === "subagent_event") onStart()
    },
  }
  const run = runSpawn({ task: "balaie" }, ctx, deps(waitsForAbort))
  await startedRun
  controller.abort()
  const result = await run
  assert.ok("success" in result && result.success === false)
  assertPaired(emitted, "aborted")
})

test("buffered counts what THIS child staged, not what a concurrent sibling staged", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const staging = (n: number): SpawnRunner =>
    async function* ({ toolContext }) {
      if (toolContext.stagingTally) toolContext.stagingTally.added += n
      await new Promise((resolve) => setImmediate(resolve))
      yield stamp({ type: "text-delta", text: `déposé ${n}` })
    }
  const mine: Emitted[] = []
  const sibling: Emitted[] = []
  const [a, b] = await Promise.all([
    runSpawn({ task: "trois" }, makeCtx(sid, mine), deps(staging(3))),
    runSpawn({ task: "cinq" }, makeCtx(sid, sibling), deps(staging(5))),
  ])
  assert.equal("buffered_added" in a && a.buffered_added, 3)
  assert.equal("buffered_added" in b && b.buffered_added, 5)
  assert.equal(assertPaired(mine, "done").buffered, 3)
  assert.equal(assertPaired(sibling, "done").buffered, 5)
})

test("buffer_add adds its exact `added` to the child's staging tally", async () => {
  const { bufferAddTool } = await import("./buffer")
  const { BufferService } = await import("@/models/buffer/service")
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  // A discarded, already-titled candidate: buffer_add restages it (added 1)
  // and has nothing to enrich, so no background drain is scheduled.
  const ark = "ark:/12148/bpt6k9400001"
  await BufferService.registerCandidates({
    projectId: project.id,
    originTool: "corpus_search",
    restageDiscarded: false,
    candidates: [{ ark, title: "Titré" }],
  })
  await BufferService.discard(project.id, [ark])
  const tally = { added: 0 }
  const ctx: TurnScopedCtx = { ...makeCtx(sid, []), stagingTally: tally }
  await bufferAddTool.handler({ arks: [ark] }, ctx)
  assert.equal(tally.added, 1)
})

test("an already-cancelled launch claims nothing", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const controller = new AbortController()
  controller.abort()
  const ctx: TurnScopedCtx = { ...makeCtx(sid, []), signal: controller.signal }
  const result = await runSpawn({ task: "balaie" }, ctx, deps(waitsForAbort))
  assert.ok("success" in result && result.success === false)
  assert.equal(await spawnRuns(sid), 0, "no run was spent")
})

test("a claim that commits after the launch gave up is given back", async () => {
  const sid = await createTestSession(project.id, SESSION_SCOPE.CORPUS)
  const { promise: gate, resolve: open } = Promise.withResolvers<void>()
  const slowClaim = async (id: string): Promise<SpawnClaim> => {
    await gate
    return SessionQueries.claimSpawnRun(id, SPAWN_MAX_PER_SESSION)
  }
  const result = await runSpawn({ task: "balaie" }, makeCtx(sid, []), deps(waitsForAbort, 20, { claimRun: slowClaim }))
  assert.ok("success" in result && result.success === false, "the launch timed out waiting for its claim")
  open()
  for (let i = 0; i < 50 && (await spawnRuns(sid)) !== 0; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(await spawnRuns(sid), 0, "the late claim was released")
})

test("a missing session is a fault, not the quota refusal", async () => {
  const result = await runSpawn({ task: "balaie" }, makeCtx(randomUUID(), []), deps(waitsForAbort))
  assert.ok("success" in result && result.success === false)
  assert.ok(!("refused" in result), "not reported as spawn_limit")
  assert.match(result.error, /session de cette conversation est introuvable/)
})

test("a claim that fails (database down) is a failure the parent reads, never a throw", async () => {
  const sid = randomUUID()
  const result = await runSpawn(
    { task: "balaie" },
    makeCtx(sid, []),
    deps(waitsForAbort, 5_000, { claimRun: () => Promise.reject(new Error("db down")) }),
  )
  assert.ok("success" in result && result.success === false)
  assert.ok(!("refused" in result), "a fault, not the quota")
  assert.match(result.error, /compteur de sous-agents de la session est indisponible/)
})
