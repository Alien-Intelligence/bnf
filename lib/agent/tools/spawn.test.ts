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

test("corpus child default can search + stage; research child default can read RAG", () => {
  assert.ok(defaultAllowlist("corpus").includes(AGENT_TOOLS.corpusSearch), "corpus child can search")
  assert.ok(defaultAllowlist("corpus").includes(AGENT_TOOLS.bufferAdd), "corpus child can stage")
  assert.ok(defaultAllowlist("research").includes(AGENT_TOOLS.ragQuery), "research child can query RAG")
})
