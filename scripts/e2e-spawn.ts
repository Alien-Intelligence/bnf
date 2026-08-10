/**
 * scripts/e2e-spawn.ts — REAL end-to-end test of the spawn_research sub-agent
 * (agent-context-survival Slice 1). Drives an ACTUAL multi-turn conversation
 * against the running dev server and asserts on DURABLE EVIDENCE:
 *
 *   - the PARENT session's `tool_call` rows show ONE `spawn_research` — and NOT
 *     the child's many `corpus_search`/`buffer_add` calls. That is the whole
 *     point: the child runs in an ISOLATED context (a directly-invoked runner,
 *     not the persisted runtime), so its transcript never enters the parent.
 *   - `buffer_item` rows nonetheless appear for the project — the child DID the
 *     work and deposited candidates into the shared buffer (BufferService writes
 *     to Postgres regardless of whose loop called it).
 *   - a `subagent_event` reached the live SSE stream.
 *
 * Run:
 *   1. PORT=3939 npm run dev
 *   2. npm run e2e:spawn        (E2E_CLEANUP=1 to drop the throwaway project)
 *
 * Exits 0 only if every assertion passes. Each run creates a FRESH project.
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import { toolsForScope } from "@/lib/agent/tools"
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { ProjectService } from "@/models/projects/service"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import {
  ARK_RE,
  BASE_URL,
  CLEANUP,
  MODEL,
  TURN_TIMEOUT_MS,
  check,
  named,
  outputData,
  printVerdict,
  requireServer,
  runTurn,
  section,
  signInCookie,
  toolCalls,
  trace,
  type ChatMessage,
} from "./e2e/harness"

const E2E_EMAIL = "e2e-spawn@bnf-e2e.local"
const E2E_PASSWORD = "e2e-spawn-pw-42"

async function main(): Promise<void> {
  console.log(`BnF spawn E2E\n  base=${BASE_URL}\n  model=${MODEL}\n  turnTimeout=${TURN_TIMEOUT_MS}ms`)
  await requireServer()

  // =========================================================================
  section("PHASE A — registration (in-process, no LLM)")
  // =========================================================================
  for (const scope of ["corpus", "research"] as const) {
    const names = toolsForScope(scope).map((t) => t.name)
    check(
      `A:${scope} scope exposes spawn_research`,
      names.includes(AGENT_TOOLS.spawnResearch),
      `tools: ${names.join(", ")}`,
    )
  }

  // =========================================================================
  section("SETUP — user, fresh project, corpus session")
  // =========================================================================
  const cookie = await signInCookie(E2E_EMAIL, E2E_PASSWORD, "E2E Spawn")
  const user = await prisma.user.findUniqueOrThrow({ where: { email: E2E_EMAIL } })
  const project = await ProjectService.create({
    name: `E2E spawn ${new Date().toISOString()}`,
    subtitle: "sous-agent — presse 1889",
    ownerId: user.id,
  })
  const corpusSession = await prisma.appSession.create({
    data: {
      id: randomUUID(),
      projectId: project.id,
      scope: SESSION_SCOPE.CORPUS,
      title: "E2E spawn corpus session",
      status: "active",
    },
  })
  console.log(`  user=${user.id}\n  project=${project.id}\n  corpusSession=${corpusSession.id}`)

  // =========================================================================
  section("PHASE B — delegate a sweep to a sub-agent, assert isolation")
  // =========================================================================
  const prompt =
    "Confie à un SOUS-AGENT le soin de rassembler des candidats : demande-lui une " +
    "recherche plein texte Gallica sur « Le Figaro » pour 1889 (une seule page de " +
    "résultats suffit) et de déposer les résultats dans le tampon. Ensuite, rends-moi " +
    "sa synthèse. Ne fais pas la recherche toi-même — délègue-la."
  const history: ChatMessage[] = [{ role: "user", content: prompt }]
  console.log(`\n> TURN 1: ${prompt}`)
  const t1 = await runTurn(corpusSession.id, cookie, history)
  console.log(`< (${Math.round(t1.elapsedMs / 1000)}s) ${t1.text.slice(0, 300)}`)
  if (t1.errors.length) console.log(`  stream errors: ${t1.errors.join(" | ")}`)

  const parentCalls = await toolCalls(corpusSession.id)
  console.log(`  parent tools: ${trace(parentCalls)}`)

  const spawnCalls = named(parentCalls, AGENT_TOOLS.spawnResearch)
  check(
    "S1 parent delegated via spawn_research",
    spawnCalls.some((c) => c.status === "ok"),
    spawnCalls.length === 0
      ? `never delegated; parent used: ${trace(parentCalls)}`
      : `${spawnCalls.length} call(s), statuses: ${spawnCalls.map((c) => c.status).join(",")}`,
  )

  // Isolation: the child's OWN tool calls (corpus_search / buffer_add / MCP
  // searches) must NOT appear in the PARENT session's persisted tool_call log —
  // they ran in a directly-invoked child runner, outside the persisted runtime.
  const childToolLeak = parentCalls.filter(
    (c) =>
      c.tool === AGENT_TOOLS.corpusSearch ||
      c.tool === AGENT_TOOLS.bufferAdd ||
      c.tool.startsWith("bnf__bnf_search_"),
  )
  check(
    "S2 child transcript did NOT leak into the parent's tool log (isolation)",
    childToolLeak.length === 0,
    childToolLeak.length === 0
      ? "parent log holds spawn_research only, no child search/stage calls"
      : `leaked ${childToolLeak.length}: ${childToolLeak.map((c) => c.tool).join(", ")}`,
  )

  // …yet the child DID the work: candidates are in the shared buffer.
  const staged = await prisma.bufferItem.findMany({ where: { projectId: project.id } })
  check(
    "S3 the sub-agent staged candidates into the shared buffer",
    staged.length > 0,
    `${staged.length} buffer_item row(s); sample: ${
      staged
        .slice(0, 3)
        .map((r) => `${r.ark}${r.title ? ` "${r.title.slice(0, 32)}"` : ""}`)
        .join(" | ") || "none"
    }`,
  )

  const badArks = staged.filter((r) => !ARK_RE.test(r.ark))
  check(
    "S4 every staged ARK satisfies the corpus ARK contract",
    badArks.length === 0,
    badArks.length === 0 ? `all ${staged.length} valid` : `${badArks.length} invalid`,
  )

  // The spawn result the parent received is a DISTILLED summary, not a transcript.
  const okSpawn = spawnCalls.find((c) => c.status === "ok")
  const spawnOut = outputData(okSpawn)
  check(
    "S5 spawn_research returned a distilled result (summary + counts)",
    typeof spawnOut["summary"] === "string" && String(spawnOut["summary"]).length > 0,
    `keys: ${Object.keys(spawnOut).join(", ") || "none"}; buffered_added=${String(
      spawnOut["buffered_added"] ?? "?",
    )}`,
  )

  check(
    "S6 a subagent_event reached the live stream",
    t1.domainEvents.some((e) => e.type === "subagent_event"),
    `domain events: ${t1.domainEvents.map((e) => e.type).join(", ") || "none"}`,
  )

  printVerdict({ project: project.id, corpusSession: corpusSession.id })

  if (CLEANUP) {
    await cleanupProject(project.id)
    console.log(`\ncleaned up project ${project.id} (+ sessions, buffer, corpus)`)
  } else {
    console.log(`\nkept project ${project.id} for inspection (set E2E_CLEANUP=1 to remove)`)
  }
}

main()
  .catch((err: unknown) => {
    console.error("\nE2E ABORTED:", err instanceof Error ? err.stack : String(err))
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
