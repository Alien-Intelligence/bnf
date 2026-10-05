// lib/agent/tools/registry-factory.test.ts
// The turn registry the chat route hands to the chat-sdk MUST be the
// rate-limited decorator, not the bare createToolRegistry — otherwise the raw
// bnf__* tools the SDK dispatches bypass the BnF quota (incident 2026-09-30).
// Behavioural, not structural: a bnf__ dispatch consumes a token, a custom tool
// dispatch does not.
import "server-only"

// Build the registry WITHOUT an MCP server: resolveMcpServers() degrades to []
// when the env is absent, so the test opens no real MCP handshake. The
// decorator keys on the `bnf__` prefix, not on discovery, so coverage is
// unaffected. Each node:test file runs in its own process, so this does not
// leak into other suites.
delete process.env.BNF_MCP_URL
delete process.env.BNF_MCP_TOKEN

import { test } from "node:test"
import assert from "node:assert/strict"
import { buildTurnScopedRegistry, buildTurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"
import { __resetBnfRateLimiterForTests } from "@/lib/mcp/rate-limit"
import { USER_ROLE, type PolicyUser } from "@/models/users/schema"

const ONE_TOKEN = {
  globalRpm: 1,
  catalogueRpm: 1,
  gallicaSruRpm: 1,
  iiifRpm: 1,
  issuesRpm: 1,
  grapheRpm: 1,
  maxWaitMs: 1,
}

function fakeCtx(signal: AbortSignal) {
  const user: PolicyUser = {
    id: "u-test",
    email: "u@test.local",
    name: "test",
    emailVerified: true,
    image: null,
    role: USER_ROLE.MEMBER,
    alienUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    groupIds: [],
  }
  return buildTurnScopedCtx(
    {
      user,
      appSessionId: "s-test",
      projectId: "p-test",
      corpusProjectId: "p-test",
      corpusReachable: true,
      scope: "corpus",
    },
    new Request("http://localhost/test"),
    signal,
  )
}

test("buildTurnScopedRegistry throttles bnf__ dispatches and leaves custom tools alone", async () => {
  __resetBnfRateLimiterForTests(ONE_TOKEN)
  const controller = new AbortController()
  const registry = await buildTurnScopedRegistry("corpus", controller.signal)
  const ctx = fakeCtx(controller.signal)

  // A custom tool dispatch must NOT take a BnF token. ask_user has no side
  // effects and needs no DB, so it is the probe.
  const askInput = {
    questions: [{ question: "Période ?", options: [{ label: "1880" }, { label: "1890" }] }],
  }
  for (let i = 0; i < 3; i++) {
    const r = await registry.dispatch(AGENT_TOOLS.askUser, askInput, ctx, `ask_${i}`)
    assert.equal(r.isError, false)
  }

  // The single token is still there: the first raw bnf__ call is forwarded to
  // the underlying registry (which, with no MCP server, reports "not found").
  const first = await registry.dispatch("bnf__bnf_search_catalogue", { query: "x" }, ctx, "bnf_1")
  assert.match(first.content, /not found in registry/)

  // The second is refused by the limiter before reaching the registry at all.
  const second = await registry.dispatch("bnf__bnf_search_catalogue", { query: "x" }, ctx, "bnf_2")
  assert.equal(second.isError, true)
  const parsed = JSON.parse(second.content) as { rate_limited?: boolean; success?: boolean }
  assert.equal(parsed.rate_limited, true)
  assert.equal(parsed.success, false)
})
