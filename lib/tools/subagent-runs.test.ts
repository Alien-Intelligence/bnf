// lib/tools/subagent-runs.test.ts
// The sub-agent row's state, folded from the live domain events (feedback
// #10e). On 0.18.1 the start row and the done row were two unrelated rows and
// the start row's spinner never stopped: "the UI says the sub-agents are done,
// but the spinner keeps spinning". Each run now carries a runId; the reducer
// correlates start and terminal events, in any order, across parallel runs,
// and a run whose turn ended with no terminal event reads `interrupted`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { reduceSubagentRuns } from "./subagent-runs"

const start = (runId: string, label = "balaie 1937") => ({
  type: "subagent_event",
  data: { kind: "start", runId, scope: "corpus", label },
})
const terminal = (runId: string, kind: "done" | "error" | "timeout" | "aborted", extra: object = {}) => ({
  type: "subagent_event",
  data: { kind, runId, scope: "corpus", toolCalls: 4, ...extra },
})

test("start then done resolves the run (the spinner bug)", () => {
  const runs = reduceSubagentRuns([{ streaming: true, events: [start("a"), terminal("a", "done", { buffered: 12 })] }])
  assert.deepEqual(runs.get("a"), { status: "done", label: "balaie 1937", toolCalls: 4, buffered: 12 })
})

test("two parallel runs whose done events arrive in reverse order", () => {
  const runs = reduceSubagentRuns([
    {
      streaming: false,
      events: [start("a", "A"), start("b", "B"), terminal("b", "done"), terminal("a", "done")],
    },
  ])
  assert.equal(runs.get("a")?.status, "done")
  assert.equal(runs.get("a")?.label, "A")
  assert.equal(runs.get("b")?.status, "done")
  assert.equal(runs.get("b")?.label, "B")
})

test("start then timeout", () => {
  const runs = reduceSubagentRuns([{ streaming: false, events: [start("a"), terminal("a", "timeout")] }])
  assert.deepEqual(runs.get("a"), { status: "timeout", label: "balaie 1937", toolCalls: 4 })
})

test("an error carries its message", () => {
  const runs = reduceSubagentRuns([{ streaming: false, events: [start("a"), terminal("a", "error", { error: "boom" })] }])
  assert.deepEqual(runs.get("a"), { status: "error", label: "balaie 1937", toolCalls: 4, error: "boom" })
})

test("a start with no terminal event in a FINISHED turn is interrupted, never spinning", () => {
  const runs = reduceSubagentRuns([{ streaming: false, events: [start("a")] }])
  assert.deepEqual(runs.get("a"), { status: "interrupted", label: "balaie 1937" })
})

test("a start with no terminal event in a STREAMING turn is still running", () => {
  const runs = reduceSubagentRuns([{ streaming: true, events: [start("a")] }])
  assert.deepEqual(runs.get("a"), { status: "running", label: "balaie 1937" })
})

test("a terminal without a matching start, and events without a runId, are ignored", () => {
  const runs = reduceSubagentRuns([
    {
      streaming: false,
      events: [
        terminal("ghost", "done"),
        { type: "subagent_event", data: { kind: "start", scope: "corpus" } },
        { type: "subagent_event", data: { kind: "done", scope: "corpus", toolCalls: 3 } },
        { type: "buffer_event", data: { kind: "added", count: 1, total: 1 } },
      ],
    },
  ])
  assert.equal(runs.size, 0)
})
