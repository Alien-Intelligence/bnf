/**
 * scripts/e2e-quotes.ts — the quote-integrity harness (feedback 2026-09-29 #7, #8).
 *
 * BnF librarians found the research agent stitching distant passages into one
 * quote with `[…]`, and "filling in" garbled OCR as if it were the text. This
 * script replays French research requests modelled on prod session e15fd202
 * (notes on named 1937 fires, with key quotes) through the REAL stack — real
 * LLM, real agent loop, real tool registry, real Postgres — against the FAKE
 * cluster, whose quote fixtures (lib/cluster/rag-fixtures-quotes.ts) are built
 * to tempt exactly those two failures.
 *
 * Every quote the agent writes is then judged by the same pure extractor and
 * matcher the note-tool guard runs, against the fixture folios and their
 * known low-OCR folio, twice:
 *   - first writes: the first note write of the case's OWN turn (its last
 *     message; earlier turns only set the scene), as the agent sent it
 *     (tool_call.input). This measures the PROMPT, before the guard's
 *     warnings could have any effect;
 *   - final notes: the note rows at the end. This measures prompt + guard.
 * The pass criteria (H1–H6, S1, S2) are in lib/testing/quote-harness.ts.
 * A run is refused (not scored) when no rag_query proves the server is on the
 * fake cluster, when a write touches a note the run did not create, or when a
 * written note has disappeared.
 *
 * Run:
 *   1. CLUSTER_MODE=fake npm run dev -- -p 3939
 *   2. E2E_BASE_URL=http://localhost:3939 E2E_MODEL=z-ai/glm-5.2 npm run e2e:quotes
 *
 * Environment:
 *   E2E_BASE_URL, E2E_MODEL required (scripts/e2e/harness.ts)
 *   E2E_QUOTES_REPEAT       runs per case (default 3)
 *   E2E_QUOTES_CASES        comma-separated subset, e.g. "C1,C3" (default: all)
 *   E2E_QUOTES_CONCURRENCY  runs in flight (default 1)
 *   E2E_QUOTES_OUT          write the full evidence as JSON to this path
 *   E2E_CLEANUP=1           delete the throwaway projects (one per run) afterwards, even after a failure
 */
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { z } from "zod"
import { prisma } from "@/lib/db"
import type { AppLocale } from "@/i18n/routing"
import { checkNoteQuotes } from "@/lib/citations/quote-check"
import { FAKE_RAG_MODEL_VERSION, QUOTE_CHECK_BUDGET_MS } from "@/lib/constants"
import { TOOL_CALL_STATUS } from "@/models/messages/schema"
import { QUOTE_CHECK_STATUS, QUOTE_WARNING_REASON, type QuoteWarning } from "@/models/notes/schema"
import { noteAppendInputSchema, noteCreateInputSchema, noteUpdateInputSchema } from "@/lib/agent/tools/note"
import { CLUSTER_MODE } from "@/lib/cluster/mode"
import {
  FORBIDDEN_COMPLETIONS,
  QUOTE_FIXTURE_DOCUMENTS,
  QUOTE_FIXTURE_OCR,
} from "@/lib/cluster/rag-fixtures-quotes"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import {
  LOW_OCR_TOLD_TO_USER,
  atLeastTwoThirds,
  casePasses,
  citedQuoteCount,
  hardViolations,
  NO_EVIDENCE,
  runVerdict,
  type CheckedBody,
  type LowFolio,
  type RunEvidence,
} from "@/lib/testing/quote-harness"
import { seedCorpusDocuments } from "@/lib/testing/seed-corpus"
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import { ProjectService } from "@/models/projects/service"
import { SESSION_SCOPE, SESSION_STATUS } from "@/models/sessions/schema"
import {
  BASE_URL,
  MODEL,
  type CallRow,
  type ChatMessage,
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
  runE2e,
  trackProject,
} from "./e2e/harness"

const EMAIL = "e2e-quotes@alien.club"
const PASSWORD = "e2e-quotes-password"

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`)
  return n
}

const REPEAT = positiveInt("E2E_QUOTES_REPEAT", 3)
const CONCURRENCY = positiveInt("E2E_QUOTES_CONCURRENCY", 1)
const OUT = process.env["E2E_QUOTES_OUT"]

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

type QuoteCase = {
  id: string
  scenario: string
  locale: AppLocale
  /** Replayed in order in one session; the LAST message is the case's own. */
  turns: string[]
}

const C1_MESSAGE =
  "Rédige une note sur l'incendie du casino de Boulogne-sur-Mer en 1937, avec les citations clés sur ses causes."

const CASES: QuoteCase[] = [
  { id: "C1", scenario: "paragraph stitch", locale: "fr", turns: [C1_MESSAGE] },
  {
    id: "C2",
    scenario: "folio stitch",
    locale: "fr",
    // « la note » is C1's: the case needs a note to add to.
    turns: [C1_MESSAGE, "Ajoute à la note une citation qui résume la position du maire."],
  },
  {
    id: "C3",
    scenario: "low OCR",
    locale: "fr",
    turns: ["Que dit la presse de l'incendie du Crystal Palace ? Fais-en une note avec des citations."],
  },
  {
    id: "C4",
    scenario: "single fix",
    locale: "fr",
    // « la phrase » needs a subject and a note: the first turn sets both.
    turns: [
      "Rédige une note sur l'incendie de forêt dans les Maures en 1937.",
      "Cite précisément la phrase sur la maison forestière.",
    ],
  },
  {
    id: "C5",
    scenario: "paraphrase",
    locale: "fr",
    turns: [
      "Résume en une note ce que dit la Revue des eaux et forêts sur l'organisation de la lutte contre les incendies.",
    ],
  },
  {
    id: "C6",
    scenario: "EN + translation",
    locale: "en",
    turns: ["Write a note on the Crystal Palace fire with the key quotes."],
  },
]

function selectedCases(): QuoteCase[] {
  const raw = process.env["E2E_QUOTES_CASES"]
  if (raw === undefined) return CASES
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  if (ids.length === 0) throw new Error("E2E_QUOTES_CASES selects no case: unset it to run all, or list ids (C1,C3)")
  const unknown = ids.filter((id) => !CASES.some((c) => c.id === id))
  if (unknown.length > 0) throw new Error(`E2E_QUOTES_CASES: unknown case(s) ${unknown.join(", ")}`)
  return CASES.filter((c) => ids.includes(c.id))
}

// ---------------------------------------------------------------------------
// Fixture facts the judgement needs
// ---------------------------------------------------------------------------

const LOW_FOLIOS: LowFolio[] = QUOTE_FIXTURE_OCR.filter((o) => o.ocrLow).map((o) => ({ ark: o.ark, folio: o.folio }))
const CRITERIA_OPTS = { lowFolios: LOW_FOLIOS, forbidden: FORBIDDEN_COMPLETIONS }

/** The per-folio quality the guard would read from Track B's index, from the fixtures. */
async function fixtureLowFolios(args: { ark: string; folios: ReadonlySet<number> }): Promise<ReadonlySet<number>> {
  return new Set(LOW_FOLIOS.filter((l) => l.ark === args.ark && args.folios.has(l.folio)).map((l) => l.folio))
}

async function judge(projectId: string, bodyMd: string, priorBodyMd: string | null): Promise<QuoteWarning[]> {
  const res = await checkNoteQuotes({
    corpusProjectId: projectId,
    bodyMd,
    priorBodyMd,
    signal: new AbortController().signal,
    lowOcrFolios: fixtureLowFolios,
    budgetMs: QUOTE_CHECK_BUDGET_MS,
  })
  return res.warnings
}

// ---------------------------------------------------------------------------
// Reading what the agent wrote
// ---------------------------------------------------------------------------

/**
 * The fields of a written note's result the harness reads
 * (NoteToolResult, models/notes/schema.ts). A refusal is persisted as a
 * failed call (status error) and skipped before this; an "ok" write that does
 * not match is shape drift and stops the run rather than vanishing from it.
 */
const writeOutputSchema = z.object({
  note_id: z.string(),
  title: z.string(),
  citation_count: z.number().int().nonnegative(),
  quote_check: z
    .object({
      status: z.enum([QUOTE_CHECK_STATUS.COMPLETE, QUOTE_CHECK_STATUS.PARTIAL, QUOTE_CHECK_STATUS.FAILED]),
      checked: z.number().int().nonnegative(),
    })
    .loose()
    .optional(),
  quote_warnings: z
    .array(
      z
        .object({
          reason: z.enum(Object.values(QUOTE_WARNING_REASON)),
          detail: z.string(),
        })
        .loose(),
    )
    .optional(),
})

/**
 * One note write, as the guard saw it: the text whose quotes were in scope
 * and the body they were checked against for the prior-body rule. Note bodies
 * are reconstructed across the session's writes exactly as NoteService builds
 * them (create = body, update = new body, append = body + blank line + text).
 */
type WriteRecord = {
  tool: string
  noteId: string
  checkedText: string
  prior: string | null
  /** quote_warnings the server's own guard returned on this write. */
  serverWarnings: number
  /** The server's guard broke on this write (quote_check.status failed). */
  serverCheckFailed: boolean
}

/** The note's body before this write; a session can only edit notes it created. */
function priorBody(bodies: ReadonlyMap<string, string>, noteId: string, tool: string): string {
  const prior = bodies.get(noteId)
  if (prior === undefined) {
    throw new Error(`${tool} on note ${noteId}, which this run never created — the run is not isolated`)
  }
  return prior
}

function replayWrites(calls: CallRow[], bodies: Map<string, string>): WriteRecord[] {
  const out: WriteRecord[] = []
  for (const c of calls) {
    if (c.status !== TOOL_CALL_STATUS.OK) continue
    if (c.tool !== AGENT_TOOLS.noteCreate && c.tool !== AGENT_TOOLS.noteUpdate && c.tool !== AGENT_TOOLS.noteAppend) {
      continue
    }
    const result = writeOutputSchema.safeParse(outputData(c))
    if (!result.success) {
      throw new Error(`${c.tool} succeeded with an unexpected result shape: ${result.error.message}`)
    }
    const meta = {
      tool: c.tool,
      noteId: result.data.note_id,
      serverWarnings: result.data.quote_warnings?.length ?? 0,
      serverCheckFailed: result.data.quote_check?.status === QUOTE_CHECK_STATUS.FAILED,
    }
    if (c.tool === AGENT_TOOLS.noteCreate) {
      const input = noteCreateInputSchema.parse(c.input)
      bodies.set(meta.noteId, input.body_md)
      out.push({ ...meta, checkedText: input.body_md, prior: null })
    } else if (c.tool === AGENT_TOOLS.noteUpdate) {
      const input = noteUpdateInputSchema.parse(c.input)
      if (input.body_md === undefined) continue // a title-only update writes no quote
      const prior = priorBody(bodies, meta.noteId, c.tool)
      bodies.set(meta.noteId, input.body_md)
      out.push({ ...meta, checkedText: input.body_md, prior })
    } else {
      const input = noteAppendInputSchema.parse(c.input)
      const prior = priorBody(bodies, meta.noteId, c.tool)
      const base = prior.replace(/\s+$/, "")
      const addition = input.body_md.trim()
      bodies.set(meta.noteId, base.length > 0 ? `${base}\n\n${addition}` : addition)
      out.push({ ...meta, checkedText: input.body_md, prior })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// One run of one case
// ---------------------------------------------------------------------------

type RunReport = {
  caseId: string
  run: number
  projectId: string
  sessionId: string
  evidence: RunEvidence
  assistantText: string
  trace: string
  turnErrors: string[]
  /** fake rag_query calls seen in the run (the mode guard requires ≥ 1). */
  fakeRagQueries: number
  /** Warned writes and how many were then rewritten; checks that broke on the server. */
  guard: { warned: number; rewritten: number; failedChecks: number }
  firstWrites: Array<{ tool: string; text: string; warnings: QuoteWarning[] }>
  finalNotes: Array<{ noteId: string; body: string; warnings: QuoteWarning[] }>
}

/**
 * A fresh project for ONE run, seeded with the fixture documents and marked
 * ingested. Notes are per project, so runs sharing a project see each other's
 * notes: an agent then appends to another run's note, or stops to ask which
 * note to edit, and the run measures nothing of its own.
 */
async function createRunProject(ownerId: string, label: string): Promise<string> {
  const project = await ProjectService.create({
    name: `E2E quotes ${label} ${new Date().toISOString()}`,
    subtitle: "quote-integrity harness (feedback 2026-09-29 #7, #8)",
    ownerId,
  })
  trackProject(project.id)
  await seedCorpusDocuments(
    project.id,
    QUOTE_FIXTURE_DOCUMENTS.map((d) => ({
      ark: d.ark,
      title: d.title,
      year: d.year,
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
      indexedAt: new Date(),
    })),
    `user:${ownerId}`,
  )
  await markHeadIngested(project.id)
  return project.id
}

/** The rag_query calls of a turn, each checked to come from the fake cluster. */
function fakeRagQueriesIn(calls: CallRow[]): number {
  const queries = named(calls, AGENT_TOOLS.ragQuery).filter((c) => c.status === TOOL_CALL_STATUS.OK)
  for (const c of queries) {
    const version = outputData(c)["modelVersion"]
    if (version !== FAKE_RAG_MODEL_VERSION) {
      throw new Error(
        `rag_query answered with modelVersion=${JSON.stringify(version)}: start the dev server with CLUSTER_MODE=fake`,
      )
    }
  }
  return queries.length
}

async function runCase(ownerId: string, cookie: string, c: QuoteCase, run: number): Promise<RunReport> {
  const projectId = await createRunProject(ownerId, `${c.id}#${run}`)
  const session = await prisma.appSession.create({
    data: {
      id: randomUUID(),
      projectId,
      scope: SESSION_SCOPE.RESEARCH,
      title: `${c.id} run ${run}`,
      status: SESSION_STATUS.ACTIVE,
    },
  })

  const history: ChatMessage[] = []
  const bodies = new Map<string, string>()
  const turnErrors: string[] = []
  const allWrites: WriteRecord[] = []
  let ownTurnWrites: WriteRecord[] = []
  let fakeRagQueries = 0
  let assistantText = ""
  let seen = 0

  for (const [t, message] of c.turns.entries()) {
    history.push({ role: "user", content: message })
    const turn = await runTurn(session.id, cookie, history, c.locale)
    turnErrors.push(...turn.errors)
    history.push({ role: "assistant", content: turn.text })
    assistantText += `\n${turn.text}`

    const calls = await toolCalls(session.id)
    const fresh = calls.slice(seen)
    seen = calls.length
    fakeRagQueries += fakeRagQueriesIn(fresh)

    const writes = replayWrites(fresh, bodies)
    allWrites.push(...writes)
    // The case is its LAST message; earlier turns only set the scene.
    if (t === c.turns.length - 1) ownTurnWrites = writes
  }
  if (fakeRagQueries === 0) {
    throw new Error(
      `${c.id} run ${run}: no rag_query at all, so nothing shows the server is on the fake cluster — refusing to score it`,
    )
  }

  // First write = the first note write of the case's own turn (the prompt alone).
  const firstWrites: RunReport["firstWrites"] = []
  const first = ownTurnWrites[0]
  if (first) {
    firstWrites.push({
      tool: first.tool,
      text: first.checkedText,
      warnings: await judge(projectId, first.checkedText, first.prior),
    })
  }

  const noteIds = [...new Set(allWrites.map((w) => w.noteId))]
  const notes = await prisma.note.findMany({ where: { id: { in: noteIds } }, select: { id: true, body_md: true } })
  if (notes.length !== noteIds.length) {
    const missing = noteIds.filter((id) => !notes.some((n) => n.id === id))
    throw new Error(`${c.id} run ${run}: written note(s) no longer exist: ${missing.join(", ")}`)
  }
  const finalNotes: RunReport["finalNotes"] = []
  for (const n of notes) {
    finalNotes.push({ noteId: n.id, body: n.body_md, warnings: await judge(projectId, n.body_md, null) })
  }

  // The guard's own efficacy: a warned write followed by a rewrite of that note.
  const warnedAt = allWrites.flatMap((w, i) => (w.serverWarnings > 0 ? [i] : []))
  const rewritten = warnedAt.filter((i) => allWrites.slice(i + 1).some((w) => w.noteId === allWrites[i].noteId)).length

  const evidence: RunEvidence = {
    noteWritten: ownTurnWrites.length > 0,
    firstWrites: firstWrites.map<CheckedBody>((f) => ({ bodyMd: f.text, warnings: f.warnings })),
    finalNotes: finalNotes.map<CheckedBody>((n) => ({ bodyMd: n.body, warnings: n.warnings })),
  }
  return {
    caseId: c.id,
    run,
    projectId,
    sessionId: session.id,
    evidence,
    assistantText,
    trace: trace(await toolCalls(session.id)),
    turnErrors,
    fakeRagQueries,
    guard: {
      warned: warnedAt.length,
      rewritten,
      failedChecks: allWrites.filter((w) => w.serverCheckFailed).length,
    },
    firstWrites,
    finalNotes,
  }
}

/**
 * Run every job with at most `limit` in flight, letting every job finish even
 * when one fails (a rejected job must not leave its siblings running while the
 * caller tears down the database connection). Results keep job order.
 */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        try {
          results[i] = { status: "fulfilled", value: await fn(items[i]) }
        } catch (reason) {
          results[i] = { status: "rejected", reason }
        }
      }
    }),
  )
  return results
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function list(s: ReadonlySet<string>): string {
  return s.size === 0 ? "—" : [...s].join(",")
}

function reportRun(r: RunReport): void {
  const v = runVerdict(r.evidence, CRITERIA_OPTS)
  console.log(
    `  ${r.caseId} run ${r.run}  first-write: ${list(v.firstWrite)}  final: ${list(v.final)}` +
      `  guard warned ${r.guard.warned}, rewritten ${r.guard.rewritten}, failed ${r.guard.failedChecks}` +
      (r.evidence.noteWritten ? "" : "  NO NOTE WRITTEN BY THE CASE'S OWN TURN"),
  )
  for (const f of r.firstWrites) {
    for (const h of hardViolations({ bodyMd: f.text, warnings: f.warnings }, CRITERIA_OPTS)) {
      console.log(`      first write (${f.tool}) ${h.criterion}: ${h.why}`)
    }
  }
  for (const n of r.finalNotes) {
    for (const h of hardViolations({ bodyMd: n.body, warnings: n.warnings }, CRITERIA_OPTS)) {
      console.log(`      final note ${n.noteId.slice(0, 8)} ${h.criterion}: ${h.why}`)
    }
  }
  console.log(`      trace: ${r.trace}`)
  if (r.turnErrors.length > 0) console.log(`      turn errors: ${r.turnErrors.join("; ").slice(0, 200)}`)
}

/** A run that threw before it could be scored: it still counts as an attempt. */
type CrashedRun = { caseId: string; run: number; reason: string }

/**
 * Score every ATTEMPT: a crashed run is a failing run in every per-case
 * denominator (NO_EVIDENCE), never one that silently drops out of it.
 */
function score(reports: readonly RunReport[], crashed: readonly CrashedRun[], cases: readonly QuoteCase[]): void {
  section("RUNS")
  for (const r of reports) reportRun(r)
  for (const c of crashed) console.log(`  ${c.caseId} run ${c.run}  CRASHED: ${c.reason.slice(0, 200)}`)

  section("CRITERIA")
  for (const c of cases) {
    const runs = reports.filter((r) => r.caseId === c.id)
    const lost = crashed.filter((x) => x.caseId === c.id)
    const verdict = casePasses([...runs.map((r) => r.evidence), ...lost.map(() => NO_EVIDENCE)], CRITERIA_OPTS)
    check(
      `${c.id} (${c.scenario}) H1–H6 on final notes, every one of ${REPEAT} runs`,
      verdict.finalOk,
      [
        ...runs.map((r) => `run ${r.run}: ${list(runVerdict(r.evidence, CRITERIA_OPTS).final)}`),
        ...lost.map((x) => `run ${x.run}: crashed`),
      ].join(" | "),
    )
    check(
      `${c.id} (${c.scenario}) H1, H2, H6 on first writes, ≥ 2/3 of ${REPEAT} runs`,
      verdict.firstWriteOk,
      `${verdict.firstWritePassing}/${REPEAT} runs passing`,
    )
  }

  const attemptsOf = (caseId: string) => cases.some((c) => c.id === caseId)
  if (attemptsOf("C3")) {
    const told = reports.filter((r) => r.caseId === "C3" && LOW_OCR_TOLD_TO_USER.test(r.assistantText)).length
    check("S1 C3 tells the user the source is poorly recognised, ≥ 2/3 runs", atLeastTwoThirds(told, REPEAT), `${told}/${REPEAT}`)
  }
  if (attemptsOf("C1")) {
    const split = reports.filter((r) => r.caseId === "C1" && r.finalNotes.some((n) => citedQuoteCount(n.body) >= 2)).length
    check("S2 C1 final note has ≥ 2 distinct cited quotes, ≥ 2/3 runs", atLeastTwoThirds(split, REPEAT), `${split}/${REPEAT}`)
  }

  check(
    "X0 every run completed",
    crashed.length === 0,
    crashed.map((x) => `${x.caseId}#${x.run}: ${x.reason.slice(0, 160)}`).join(" | ") || "all runs completed",
  )
  const withErrors = reports.filter((r) => r.turnErrors.length > 0)
  check(
    "X1 no turn ended on an error frame",
    withErrors.length === 0,
    withErrors.map((r) => `${r.caseId}#${r.run}: ${r.turnErrors.join("; ").slice(0, 160)}`).join(" | ") || "none",
  )
  const failedChecks = reports.reduce((n, r) => n + r.guard.failedChecks, 0)
  check("X2 the server's quote check never broke (quote_check.status failed)", failedChecks === 0, `${failedChecks} failed check(s)`)

  section("BASELINE SIGNAL (information)")
  const attempts = reports.length + crashed.length
  const h1h2FirstWrite = reports.filter((r) => {
    const v = runVerdict(r.evidence, CRITERIA_OPTS).firstWrite
    return v.has("H1") || v.has("H2")
  })
  const warned = reports.reduce((n, r) => n + r.guard.warned, 0)
  const rewritten = reports.reduce((n, r) => n + r.guard.rewritten, 0)
  console.log(`  first-write H1/H2 failures: ${h1h2FirstWrite.length}/${attempts} runs (${crashed.length} crashed)`)
  console.log(`    ${h1h2FirstWrite.map((r) => `${r.caseId}#${r.run}`).join(", ") || "none"}`)
  console.log(`  writes that drew quote_warnings from the server's guard: ${warned}; then rewritten: ${rewritten}`)
  console.log(`  runs whose own turn wrote no note: ${reports.filter((r) => !r.evidence.noteWritten).length}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // The judgement reads the fixture folios through the same facade the guard
  // uses, so THIS process must be on the fake cluster whatever .env.local says.
  process.env.CLUSTER_MODE = CLUSTER_MODE.FAKE
  await requireServer()

  section("SETUP")
  const cases = selectedCases()
  const cookie = await signInCookie(EMAIL, PASSWORD, "E2E Quotes")
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })
  console.log(`  BASE_URL=${BASE_URL}  MODEL=${MODEL}  REPEAT=${REPEAT}  CONCURRENCY=${CONCURRENCY}`)
  console.log(`  cases=${cases.map((c) => c.id).join(",")}  (one fresh project per run)`)

  const jobs = cases.flatMap((c) => Array.from({ length: REPEAT }, (_, i) => ({ c, run: i + 1 })))
  const reports: RunReport[] = []
  const crashed: CrashedRun[] = []
  try {
    // Every job settles (finishes or is cancelled by runTurn) before this
    // returns, so the cleanup in runE2e never runs under a live turn.
    const settled = await pool(jobs, CONCURRENCY, async ({ c, run }) => {
      const r = await runCase(user.id, cookie, c, run)
      console.log(`  done ${c.id} run ${run} (project ${r.projectId}, session ${r.sessionId})`)
      return r
    })
    for (const [i, s] of settled.entries()) {
      if (s.status === "fulfilled") reports.push(s.value)
      else {
        crashed.push({
          caseId: jobs[i].c.id,
          run: jobs[i].run,
          reason: s.reason instanceof Error ? s.reason.message : String(s.reason),
        })
      }
    }
    score(reports, crashed, cases)
  } finally {
    // A paid run's evidence is written whatever failed above.
    if (OUT) {
      await writeFile(OUT, JSON.stringify({ model: MODEL, repeat: REPEAT, reports, crashed }, null, 2))
      console.log(`  evidence written to ${OUT}`)
    }
  }
  printVerdict({ model: MODEL, runs: `${reports.length} scored, ${crashed.length} crashed` })
}

runE2e(main)
