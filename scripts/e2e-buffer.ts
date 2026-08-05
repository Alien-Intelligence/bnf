/**
 * scripts/e2e-buffer.ts — REAL end-to-end test of the research buffer ("tampon").
 *
 * This is not a unit test and not a mock. It drives an ACTUAL multi-turn
 * conversation against the running dev server:
 *   real LLM (via the configured AGENT_PROVIDER gateway)
 *   → real agent loop (@alien/chat-sdk TurnRuntime)
 *   → real scope-gated tool registry
 *   → real BnF MCP (live SRU search)
 *   → real Postgres
 * and then asserts on DURABLE EVIDENCE rather than on the model's prose:
 *   - `tool_call` rows (persisted by the runtime: name, input, output, status)
 *   - `buffer_item` rows (candidates staged / committed)
 *   - `corpus_version` + `corpus_membership` (did the corpus actually advance?)
 *   - `note` rows (did the ingestion guard actually block the write?)
 *
 * Run:
 *   1. Start the app:  PORT=3939 npm run dev
 *   2. npm run e2e:buffer            (optionally E2E_MODEL=... E2E_BASE_URL=...)
 *
 * Exits 0 only if every assertion passes; 1 otherwise. Prints a verdict table.
 * Each run creates a FRESH project so assertions are never polluted by history.
 */
import { randomUUID } from "node:crypto"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { LOCALE_HEADER } from "@/lib/constants"
import { toolsForScope } from "@/lib/agent/tools"
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { noteCreateTool } from "@/lib/agent/tools/note"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { BUFFER_STATUS } from "@/models/buffer/schema"
import { ProjectService } from "@/models/projects/service"

const BASE_URL = (process.env["E2E_BASE_URL"] ?? "http://localhost:3939").replace(/\/+$/, "")
/** Model id for the OpenRouter gateway. Defaults to the app's shipped default. */
const MODEL = process.env["E2E_MODEL"] ?? "z-ai/glm-5.2"
/** Per-turn wall-clock ceiling — a paginated sweep legitimately takes a while. */
const TURN_TIMEOUT_MS = Number(process.env["E2E_TURN_TIMEOUT_MS"] ?? 300_000)

const E2E_EMAIL = "e2e-buffer@bnf-e2e.local"
const E2E_PASSWORD = "e2e-buffer-pw-42"

/** ARK shape the corpus contract mandates (models/corpus/types.ts arkSchema). */
const ARK_RE = /^ark:\/\d+\/[A-Za-z0-9]+$/

// ---------------------------------------------------------------------------
// Verdict tracking
// ---------------------------------------------------------------------------
type Verdict = { name: string; ok: boolean; detail: string }
const verdicts: Verdict[] = []

function check(name: string, ok: boolean, detail: string): void {
  verdicts.push({ name, ok, detail })
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}\n        ${detail}`)
}

function section(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`)
}

// ---------------------------------------------------------------------------
// Auth — better-auth round trip, returns the Cookie header for the HTTP calls
// ---------------------------------------------------------------------------
function isEmailTaken(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  const body = e["body"] as Record<string, unknown> | undefined
  return body?.["code"] === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" || e["status"] === "UNPROCESSABLE_ENTITY"
}

async function signInCookie(): Promise<string> {
  try {
    await auth.api.signUpEmail({
      body: { email: E2E_EMAIL, password: E2E_PASSWORD, name: "E2E Buffer" },
    })
  } catch (err) {
    if (!isEmailTaken(err)) throw err
  }
  const res = await auth.api.signInEmail({
    body: { email: E2E_EMAIL, password: E2E_PASSWORD },
    asResponse: true,
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  if (setCookie.length === 0) throw new Error("sign-in returned no Set-Cookie")
  // Reduce "name=value; Path=/; ..." entries down to the "name=value" pairs.
  return setCookie.map((c) => c.split(";")[0]).join("; ")
}

// ---------------------------------------------------------------------------
// One real agent turn over SSE
// ---------------------------------------------------------------------------
interface ChatMessage {
  role: "user" | "assistant"
  content: string
}
interface TurnResult {
  text: string
  frames: Record<string, unknown>[]
  domainEvents: { type: string; data: unknown }[]
  errors: string[]
  elapsedMs: number
}

async function runTurn(
  sessionId: string,
  cookie: string,
  history: ChatMessage[],
): Promise<TurnResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS)

  const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      [LOCALE_HEADER]: "fr",
    },
    body: JSON.stringify({ sessionId, mode: "claude", messages: history, model: MODEL }),
    signal: controller.signal,
  }).catch((err: unknown) => {
    clearTimeout(timer)
    throw new Error(`turn POST failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  if (!res.ok || !res.body) {
    clearTimeout(timer)
    const body = await res.text().catch(() => "")
    throw new Error(`turn POST ${res.status}: ${body.slice(0, 300)}`)
  }

  const frames: Record<string, unknown>[] = []
  const domainEvents: { type: string; data: unknown }[] = []
  const errors: string[] = []
  let text = ""
  let buf = ""

  const decoder = new TextDecoder()
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let sep: number
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === "[DONE]") continue
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(raw) as Record<string, unknown>
          } catch {
            continue
          }
          frames.push(frame)
          const type = String(frame["type"] ?? "")
          if (type === "text-delta" && typeof frame["text"] === "string") text += frame["text"]
          else if (type === "error") errors.push(String(frame["message"] ?? "unknown error"))
          else if (type.endsWith("_event")) domainEvents.push({ type, data: frame["data"] })
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }

  return { text, frames, domainEvents, errors, elapsedMs: Date.now() - started }
}

// ---------------------------------------------------------------------------
// Evidence helpers — read what the agent ACTUALLY did from the DB
// ---------------------------------------------------------------------------
interface CallRow {
  tool: string
  status: string
  input: unknown
  output: unknown
  error: string | null
}

async function toolCalls(sessionId: string): Promise<CallRow[]> {
  const rows = await prisma.toolCall.findMany({
    where: { message: { appSessionId: sessionId } },
    orderBy: { createdAt: "asc" },
    select: { tool: true, status: true, input: true, output: true, error: true },
  })
  return rows as CallRow[]
}

function named(calls: CallRow[], tool: string): CallRow[] {
  return calls.filter((c) => c.tool === tool)
}

/** Compact one-line trace of the tool sequence, for the report. */
function trace(calls: CallRow[]): string {
  if (calls.length === 0) return "(no tool calls)"
  return calls.map((c) => `${c.tool}${c.status === "ok" ? "" : `!${c.status}`}`).join(" → ")
}

function outputText(row: CallRow | undefined): string {
  if (!row) return ""
  return typeof row.output === "string" ? row.output : JSON.stringify(row.output ?? {})
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`BnF buffer E2E\n  base=${BASE_URL}\n  model=${MODEL}\n  turnTimeout=${TURN_TIMEOUT_MS}ms`)

  // Fail fast if the server isn't up — otherwise every turn error looks like a bug.
  const health = await fetch(`${BASE_URL}/api/health`, { method: "GET" }).catch(() => null)
  if (health === null) {
    throw new Error(`dev server unreachable at ${BASE_URL} — start it with: PORT=3939 npm run dev`)
  }

  // =========================================================================
  section("PHASE A — scope gating (in-process, no LLM)")
  // =========================================================================
  const corpusToolNames = toolsForScope("corpus").map((t) => t.name)
  const researchToolNames = toolsForScope("research").map((t) => t.name)

  const bufferToolNames: string[] = [
    AGENT_TOOLS.corpusSearch,
    AGENT_TOOLS.bufferList,
    AGENT_TOOLS.bufferStats,
    AGENT_TOOLS.bufferRemoveByFilter,
    AGENT_TOOLS.bufferAdd,
    AGENT_TOOLS.bufferDiscard,
    AGENT_TOOLS.bufferCommit,
    AGENT_TOOLS.bufferClear,
  ]
  const missingInCorpus = bufferToolNames.filter((n) => !corpusToolNames.includes(n))
  check(
    "A1 corpus scope exposes corpus_search + every buffer_* tool",
    missingInCorpus.length === 0,
    missingInCorpus.length === 0 ? `all ${bufferToolNames.length} present` : `missing: ${missingInCorpus.join(", ")}`,
  )

  const noteLeak = corpusToolNames.filter((n) => n.startsWith("note_"))
  check(
    "A2 corpus scope carries NO note_* tools",
    noteLeak.length === 0,
    noteLeak.length === 0 ? "none registered" : `leaked: ${noteLeak.join(", ")}`,
  )

  const bufferLeak = researchToolNames.filter(
    (n) => n.startsWith("buffer_") || n === AGENT_TOOLS.corpusSearch,
  )
  check(
    "A3 research scope carries NO buffer_*/corpus_search tools",
    bufferLeak.length === 0,
    bufferLeak.length === 0 ? "none registered" : `leaked: ${bufferLeak.join(", ")}`,
  )
  check(
    "A4 research scope still has note_* tools",
    researchToolNames.includes(AGENT_TOOLS.noteCreate),
    `research tools: ${researchToolNames.join(", ")}`,
  )

  // =========================================================================
  section("SETUP — user, fresh project, corpus session")
  // =========================================================================
  const cookie = await signInCookie()
  const user = await prisma.user.findUniqueOrThrow({ where: { email: E2E_EMAIL } })
  const project = await ProjectService.create({
    name: `E2E buffer ${new Date().toISOString()}`,
    subtitle: "presse française 1889",
    ownerId: user.id,
  })
  const corpusSession = await prisma.appSession.create({
    data: {
      id: randomUUID(),
      projectId: project.id,
      scope: SESSION_SCOPE.CORPUS,
      title: "E2E corpus session",
      status: "active",
    },
  })
  console.log(`  user=${user.id}\n  project=${project.id}\n  corpusSession=${corpusSession.id}`)

  const history: ChatMessage[] = []

  // =========================================================================
  section("PHASE B — live conversation: search → stage → curate → commit")
  // =========================================================================

  // --- Turn 1: search + stage ------------------------------------------------
  // Explicitly a FULL-TEXT SEARCH (not a periodical enumeration): this is the
  // path that returns periodical COLLECTION entries (`cb…/date`) and so is the
  // regression case for the ARK-normalisation bug this e2e originally caught.
  const t1Prompt =
    "Fais une recherche plein texte dans Gallica sur « Le Figaro » pour l'année 1889 " +
    "et rassemble les résultats pour que je puisse les examiner. " +
    "N'énumère pas les numéros du périodique : je veux une recherche. Une seule page suffit."
  history.push({ role: "user", content: t1Prompt })
  console.log(`\n> TURN 1: ${t1Prompt}`)
  const t1 = await runTurn(corpusSession.id, cookie, history)
  history.push({ role: "assistant", content: t1.text })
  console.log(`< (${Math.round(t1.elapsedMs / 1000)}s) ${t1.text.slice(0, 300)}`)
  if (t1.errors.length) console.log(`  stream errors: ${t1.errors.join(" | ")}`)

  const callsT1 = await toolCalls(corpusSession.id)
  console.log(`  tools: ${trace(callsT1)}`)

  // The INVARIANT (not the tool choice): everything the agent gathered reached
  // the buffer through a funnelled path. Enumerating a periodical's issues with
  // bnf__bnf_get_periodical_issues → buffer_add is equally legitimate, so
  // asserting corpus_search specifically would over-specify the agent's method.
  const searchCalls = named(callsT1, AGENT_TOOLS.corpusSearch)
  const stageCalls = named(callsT1, AGENT_TOOLS.bufferAdd)
  check(
    "B1 gathered documents entered the buffer via a funnelled path",
    searchCalls.some((c) => c.status === "ok") || stageCalls.some((c) => c.status === "ok"),
    `corpus_search=${searchCalls.length} buffer_add=${stageCalls.length}; used: ${trace(callsT1)}`,
  )

  const rawSearchLeak = callsT1.filter((c) => c.tool.startsWith("bnf__bnf_search_"))
  check(
    "B2 agent did NOT bypass the buffer via raw bnf__bnf_search_*",
    rawSearchLeak.length === 0,
    rawSearchLeak.length === 0
      ? "no raw search calls"
      : `bypassed with: ${rawSearchLeak.map((c) => c.tool).join(", ")}`,
  )

  const directAdds = named(callsT1, AGENT_TOOLS.corpusAdd)
  check(
    "B2b agent did NOT bypass the buffer with a direct corpus_add",
    directAdds.length === 0,
    directAdds.length === 0 ? "no direct corpus_add" : `${directAdds.length} direct corpus_add call(s)`,
  )

  check(
    "B2c corpus_search was exercised (ARK-normalisation regression path)",
    searchCalls.some((c) => c.status === "ok"),
    searchCalls.length === 0
      ? `NOT exercised this run — the search path (source of the cb…/date bug) went untested; used: ${trace(callsT1)}`
      : `${searchCalls.length} call(s), statuses: ${searchCalls.map((c) => c.status).join(",")}`,
  )

  const stagedAfterT1 = await prisma.bufferItem.findMany({ where: { projectId: project.id } })
  check(
    "B3 candidates were persisted to the buffer",
    stagedAfterT1.length > 0,
    `${stagedAfterT1.length} buffer_item row(s); sample: ${
      stagedAfterT1
        .slice(0, 3)
        .map((r) => `${r.ark}${r.title ? ` "${r.title.slice(0, 40)}"` : ""}`)
        .join(" | ") || "none"
    }`,
  )

  check(
    "B4 a buffer_event reached the live stream",
    t1.domainEvents.some((e) => e.type === "buffer_event"),
    `domain events: ${t1.domainEvents.map((e) => e.type).join(", ") || "none"}`,
  )

  // Contract check: every staged ARK must satisfy the corpus ARK schema, or the
  // later commit (addToCorpusSchema) will reject the whole batch.
  const badArks = stagedAfterT1.filter((r) => !ARK_RE.test(r.ark))
  check(
    "B5 every staged ARK satisfies the corpus ARK contract",
    badArks.length === 0,
    badArks.length === 0
      ? `all ${stagedAfterT1.length} ARKs valid`
      : `${badArks.length} INVALID (would break buffer_commit): ${badArks
          .slice(0, 5)
          .map((r) => r.ark)
          .join(", ")}`,
  )

  // --- Turn 2: characterise --------------------------------------------------
  const t2Prompt = "Combien de candidats as-tu rassemblés, et de quels types et périodes sont-ils ?"
  history.push({ role: "user", content: t2Prompt })
  console.log(`\n> TURN 2: ${t2Prompt}`)
  const t2 = await runTurn(corpusSession.id, cookie, history)
  history.push({ role: "assistant", content: t2.text })
  console.log(`< (${Math.round(t2.elapsedMs / 1000)}s) ${t2.text.slice(0, 300)}`)

  const callsT2 = (await toolCalls(corpusSession.id)).slice(callsT1.length)
  console.log(`  tools: ${trace(callsT2)}`)
  check(
    "B6 agent inspected the buffer (buffer_stats / buffer_list)",
    callsT2.some((c) => c.tool === AGENT_TOOLS.bufferStats || c.tool === AGENT_TOOLS.bufferList),
    `tools this turn: ${trace(callsT2)}`,
  )

  // --- Turn 3: commit --------------------------------------------------------
  const t3Prompt = "Parfait, ajoute maintenant ces documents au corpus."
  history.push({ role: "user", content: t3Prompt })
  console.log(`\n> TURN 3: ${t3Prompt}`)
  const t3 = await runTurn(corpusSession.id, cookie, history)
  history.push({ role: "assistant", content: t3.text })
  console.log(`< (${Math.round(t3.elapsedMs / 1000)}s) ${t3.text.slice(0, 300)}`)

  const allCalls = await toolCalls(corpusSession.id)
  const callsT3 = allCalls.slice(callsT1.length + callsT2.length)
  console.log(`  tools: ${trace(callsT3)}`)

  const commitCalls = named(allCalls, AGENT_TOOLS.bufferCommit)
  check(
    "B7 agent called buffer_commit",
    commitCalls.length > 0,
    commitCalls.length === 0 ? `never committed; used: ${trace(callsT3)}` : `${commitCalls.length} call(s)`,
  )
  check(
    "B8 buffer_commit SUCCEEDED (no tool error)",
    commitCalls.some((c) => c.status === "ok"),
    commitCalls.length === 0
      ? "not called"
      : `statuses: ${commitCalls.map((c) => c.status).join(",")}; output/err: ${(
          commitCalls[0].error ?? outputText(commitCalls[0])
        ).slice(0, 240)}`,
  )

  const finalProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } })
  const headVersion = finalProject.headVersionId
    ? await prisma.corpusVersion.findUnique({ where: { id: finalProject.headVersionId } })
    : null
  const memberCount = headVersion
    ? await prisma.corpusMembership.count({ where: { versionId: headVersion.id } })
    : 0
  check(
    "B9 the corpus actually advanced a version and gained members",
    (headVersion?.seq ?? 0) > 1 && memberCount > 0,
    `headSeq=${headVersion?.seq ?? "none"} members=${memberCount}`,
  )

  const docCount = await prisma.document.count({ where: { projectId: project.id } })
  check("B10 Document rows exist for the committed ARKs", docCount > 0, `${docCount} document row(s)`)

  // The invariant that actually matters: a malformed identifier must never reach
  // the versioned corpus. The service layer below the tools does NOT re-run the
  // route's Zod schema, so this is the only place it is enforced end to end.
  const allDocs = await prisma.document.findMany({
    where: { projectId: project.id },
    select: { ark: true },
  })
  const badDocs = allDocs.filter((d) => !ARK_RE.test(d.ark))
  check(
    "B12 NO malformed ARK reached Document / the corpus",
    badDocs.length === 0,
    badDocs.length === 0
      ? `all ${allDocs.length} corpus ARKs valid`
      : `${badDocs.length} corrupt corpus member(s): ${badDocs.slice(0, 5).map((d) => d.ark).join(", ")}`,
  )

  const remainingCandidates = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.CANDIDATE },
  })
  const committedRows = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.COMMITTED },
  })
  check(
    "B11 committed candidates left the active buffer",
    remainingCandidates === 0 && committedRows > 0,
    `candidate=${remainingCandidates} committed=${committedRows}`,
  )

  // =========================================================================
  section("PHASE C — note ingestion guard (research session, nothing ingested)")
  // =========================================================================
  const researchSession = await prisma.appSession.create({
    data: {
      id: randomUUID(),
      projectId: project.id,
      scope: SESSION_SCOPE.RESEARCH,
      title: "E2E research session",
      status: "active",
    },
  })
  const notesBefore = await prisma.note.count({ where: { projectId: project.id } })

  // Deterministic proof of the guard: invoke the note_create handler directly.
  // The live turn below depends on the model choosing to attempt a note, which
  // it may (correctly) decline to do — that would leave the guard unexercised.
  const guardCtx = {
    signal: new AbortController().signal,
    db: prisma,
    user,
    appSessionId: researchSession.id,
    projectId: project.id,
    scope: "research" as const,
  } as unknown as Parameters<typeof noteCreateTool.handler>[1]
  const guardResult = (await noteCreateTool.handler(
    { title: "E2E guard probe", body_md: "Ceci ne doit pas être écrit." },
    guardCtx,
  )) as Record<string, unknown>
  const guardNotes = await prisma.note.count({ where: { projectId: project.id } })
  check(
    "C0 note_create is refused outright when nothing is ingested (direct call)",
    typeof guardResult["error"] === "string" && guardNotes === notesBefore,
    `returned=${JSON.stringify(guardResult).slice(0, 160)} noteCount=${guardNotes}`,
  )

  const cPrompt =
    "Rédige une note de recherche intitulée « Le Figaro en 1889 » résumant ce que contient le corpus."
  console.log(`\n> RESEARCH TURN: ${cPrompt}`)
  const c1 = await runTurn(researchSession.id, cookie, [{ role: "user", content: cPrompt }])
  console.log(`< (${Math.round(c1.elapsedMs / 1000)}s) ${c1.text.slice(0, 300)}`)

  const researchCalls = await toolCalls(researchSession.id)
  console.log(`  tools: ${trace(researchCalls)}`)
  const noteWrites = researchCalls.filter(
    (c) =>
      c.tool.startsWith("note_") && c.tool !== AGENT_TOOLS.noteList && c.tool !== AGENT_TOOLS.noteGet,
  )
  const notesAfter = await prisma.note.count({ where: { projectId: project.id } })

  check(
    "C1 no note was written before ingestion",
    notesAfter === notesBefore,
    `notes before=${notesBefore} after=${notesAfter}`,
  )
  check(
    "C2 note write attempts were refused by the ingestion guard",
    noteWrites.length === 0 || noteWrites.every((c) => /ingé|ingest/i.test(outputText(c))),
    noteWrites.length === 0
      ? "agent never attempted a note write (guard untested by this run, but nothing leaked)"
      : `attempts=${noteWrites.length}; first output: ${outputText(noteWrites[0]).slice(0, 200)}`,
  )
  const corpusToolLeakInResearch = researchCalls.filter(
    (c) => c.tool.startsWith("buffer_") || c.tool === AGENT_TOOLS.corpusSearch,
  )
  check(
    "C3 research session could not reach buffer/corpus_search tools",
    corpusToolLeakInResearch.length === 0,
    corpusToolLeakInResearch.length === 0
      ? "none called"
      : `leaked: ${corpusToolLeakInResearch.map((c) => c.tool).join(", ")}`,
  )

  // =========================================================================
  section("VERDICT")
  // =========================================================================
  const failed = verdicts.filter((v) => !v.ok)
  for (const v of verdicts) console.log(`${v.ok ? "PASS" : "FAIL"}  ${v.name}`)
  console.log(
    `\n${verdicts.length - failed.length}/${verdicts.length} passed` +
      `\nproject=${project.id} corpusSession=${corpusSession.id} researchSession=${researchSession.id}`,
  )

  if (failed.length > 0) {
    console.error(`\n${failed.length} FAILING ASSERTION(S):`)
    for (const f of failed) console.error(`  - ${f.name}\n      ${f.detail}`)
    process.exitCode = 1
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
