// lib/agent/tools/scope-gating.test.ts
// Boundary gating (plan §3.5 layer 1): the tool registry a session carries is
// selected by scope. A corpus session must NOT be able to reach note_* tools; a
// research session must NOT be able to reach buffer_*/corpus_search. This is the
// in-process half of the e2e's PHASE A — kept here as a fast, LLM-free unit so a
// gating regression is caught in milliseconds without a live agent.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { toolsForScope } from "./index"
import { AGENT_TOOLS } from "./constants"

const corpus = toolsForScope("corpus").map((t) => t.name)
const research = toolsForScope("research").map((t) => t.name)

const BUFFER_TOOLS = [
  AGENT_TOOLS.corpusSearch,
  AGENT_TOOLS.bufferList,
  AGENT_TOOLS.bufferStats,
  AGENT_TOOLS.bufferRemoveByFilter,
  AGENT_TOOLS.bufferAdd,
  AGENT_TOOLS.bufferDiscard,
  AGENT_TOOLS.bufferCommit,
  AGENT_TOOLS.bufferClear,
]

test("corpus scope exposes corpus_search + every buffer_* tool", () => {
  const missing = BUFFER_TOOLS.filter((n) => !corpus.includes(n))
  assert.deepEqual(missing, [], `missing from corpus scope: ${missing.join(", ")}`)
})

test("corpus scope carries NO note_* tools", () => {
  const leaked = corpus.filter((n) => n.startsWith("note_"))
  assert.deepEqual(leaked, [], `note tools leaked into corpus scope: ${leaked.join(", ")}`)
})

test("research scope carries NO buffer_*/corpus_search tools", () => {
  const leaked = research.filter((n) => n.startsWith("buffer_") || n === AGENT_TOOLS.corpusSearch)
  assert.deepEqual(leaked, [], `corpus tools leaked into research scope: ${leaked.join(", ")}`)
})

test("research scope still has the note_* tools", () => {
  assert.ok(research.includes(AGENT_TOOLS.noteCreate), "note_create present in research scope")
})

test("every tool name is unique within a scope (no double-registration)", () => {
  for (const [scope, names] of [
    ["corpus", corpus],
    ["research", research],
  ] as const) {
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    assert.deepEqual(dupes, [], `${scope} scope has duplicate tools: ${dupes.join(", ")}`)
  }
})
