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
 *   - first writes: the first note write of each turn, as the agent sent it
 *     (tool_call.input). This measures the PROMPT, before the guard's warnings
 *     could have any effect;
 *   - final notes: the note rows at the end. This measures prompt + guard.
 * The pass criteria (H1–H6, S1, S2) are in lib/testing/quote-harness.ts.
 *
 * Run:
 *   1. CLUSTER_MODE=fake npm run dev -- -p 3939      (any port; see E2E_BASE_URL)
 *   2. npm run e2e:quotes
 *
 * Environment:
 *   E2E_BASE_URL            dev server (default http://localhost:3939)
 *   E2E_QUOTES_REPEAT       runs per case (default 3)
 *   E2E_QUOTES_CASES        comma-separated subset, e.g. "C1,C3" (default: all)
 *   E2E_QUOTES_CONCURRENCY  runs in flight (default 1)
 *   E2E_QUOTES_OUT          write the full evidence as JSON to this path
 *   E2E_CLEANUP=1           delete the throwaway projects (one per run) afterwards
 */
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { z } from "zod"
import { prisma } from "@/lib/db"
import type { AppLocale } from "@/i18n/routing"
import { checkNoteQuotes } from "@/lib/citations/quote-check"
import type { QuoteWarning } from "@/lib/citations/quote-check"
import {
  FORBIDDEN_COMPLETIONS,
  QUOTE_FIXTURE_DOCUMENTS,
  QUOTE_FIXTURE_OCR,
} from "@/lib/cluster/rag-fixtures-quotes"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import {
  LOW_OCR_TOLD_TO_USER,
  casePasses,
  citedQuoteCount,
  hardViolations,
  runVerdict,
  type CheckedBody,
  type LowFolio,
  type RunEvidence,
} from "@/lib/testing/quote-harness"
import { seedCorpusDocuments } from "@/lib/testing/seed-corpus"
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import { ProjectService } from "@/models/projects/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import {
  BASE_URL,
  CLEANUP,
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
} from "./e2e/harness"

const EMAIL = "e2e-quotes@alien.club"
const PASSWORD = "e2e-quotes-password"
/** The fake cluster's version tag — any other value means the server is on a real cluster. */
const FAKE_MODEL_VERSION = "fake-rag-v1"

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
  })
  return res.warnings
}

// ---------------------------------------------------------------------------
// Reading what the agent wrote
// ---------------------------------------------------------------------------

const WRITE_TOOLS: ReadonlySet<string> = new Set([AGENT_TOOLS.noteCreate, AGENT_TOOLS.noteUpdate, AGENT_TOOLS.noteAppend])

/** The part of a note write's input the replay reads; the tool schema guarantees the rest. */
const writeInputSchema = z.object({ body_md: z.string().optional() })

function isWrite(c: CallRow): boolean {
  return WRITE_TOOLS.has(c.tool) && c.status === "ok" && typeof outputData(c)["note_id"] === "string"
}

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
  /** What the server's own guard returned on this write. */
  serverWarnings: number
}

function replayWrites(calls: CallRow[], bodies: Map<string, string>): WriteRecord[] {
  const out: WriteRecord[] = []
  for (const c of calls.filter(isWrite)) {
    const noteId = String(outputData(c)["note_id"])
    const text = writeInputSchema.parse(c.input).body_md ?? null
    const prior = bodies.get(noteId) ?? null
    const quoteWarnings = outputData(c)["quote_warnings"]
    const serverWarnings = Array.isArray(quoteWarnings) ? quoteWarnings.length : 0
    if (c.tool === AGENT_TOOLS.noteCreate && text !== null) {
      bodies.set(noteId, text)
      out.push({ tool: c.tool, noteId, checkedText: text, prior: null, serverWarnings })
    } else if (c.tool === AGENT_TOOLS.noteUpdate) {
      if (text === null) continue // a title-only update writes no quote
      bodies.set(noteId, text)
      out.push({ tool: c.tool, noteId, checkedText: text, prior, serverWarnings })
    } else if (c.tool === AGENT_TOOLS.noteAppend && text !== null) {
      const base = (prior ?? "").replace(/\s+$/, "")
      bodies.set(noteId, base.length > 0 ? `${base}\n\n${text.trim()}` : text.trim())
      out.push({ tool: c.tool, noteId, checkedText: text, prior, serverWarnings })
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
  /** First writes that drew quote_warnings from the server's guard, and how many were then rewritten. */
  guard: { warned: number; rewritten: number }
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

async function runCase(
  ownerId: string,
  cookie: string,
  c: QuoteCase,
  run: number,
): Promise<RunReport> {
  const projectId = await createRunProject(ownerId, `${c.id}#${run}`)
  const session = await prisma.appSession.create({
    data: {
      id: randomUUID(),
      projectId,
      scope: SESSION_SCOPE.RESEARCH,
      title: `${c.id} run ${run}`,
      status: "active",
    },
  })

  const history: ChatMessage[] = []
  const bodies = new Map<string, string>()
  const turnErrors: string[] = []
  const firstWrites: RunReport["firstWrites"] = []
  const allWrites: WriteRecord[] = []
  let assistantText = ""
  let seen = 0

  for (const message of c.turns) {
    history.push({ role: "user", content: message })
    const turn = await runTurn(session.id, cookie, history, c.locale)
    turnErrors.push(...turn.errors)
    history.push({ role: "assistant", content: turn.text })
    assistantText += `\n${turn.text}`

    const calls = await toolCalls(session.id)
    const fresh = calls.slice(seen)
    seen = calls.length
    assertFakeCluster(fresh)

    const writes = replayWrites(fresh, bodies)
    allWrites.push(...writes)
    const first = writes[0]
    if (first) {
      firstWrites.push({ tool: first.tool, text: first.checkedText, warnings: await judge(projectId, first.checkedText, first.prior) })
    }
  }

  const calls = await toolCalls(session.id)
  const noteIds = [...new Set(allWrites.map((w) => w.noteId))]
  const notes = await prisma.note.findMany({ where: { id: { in: noteIds } }, select: { id: true, body_md: true } })
  const finalNotes: RunReport["finalNotes"] = []
  for (const n of notes) {
    finalNotes.push({ noteId: n.id, body: n.body_md, warnings: await judge(projectId, n.body_md, null) })
  }

  // The guard's own efficacy: a warned write followed by a rewrite of that note.
  const warnedAt = allWrites.flatMap((w, i) => (w.serverWarnings > 0 ? [i] : []))
  const rewritten = warnedAt.filter((i) => allWrites.slice(i + 1).some((w) => w.noteId === allWrites[i].noteId)).length

  const evidence: RunEvidence = {
    noteWritten: allWrites.length > 0,
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
    trace: trace(calls),
    turnErrors,
    guard: { warned: warnedAt.length, rewritten },
    firstWrites,
    finalNotes,
  }
}

/** A real cluster would make the fixtures meaningless: stop at the first sign of one. */
function assertFakeCluster(calls: CallRow[]): void {
  for (const c of named(calls, AGENT_TOOLS.ragQuery)) {
    if (c.status !== "ok") continue
    const version = outputData(c)["modelVersion"]
    if (version !== FAKE_MODEL_VERSION) {
      throw new Error(
        `rag_query answered with modelVersion=${JSON.stringify(version)}: start the dev server with CLUSTER_MODE=fake`,
      )
    }
  }
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i])
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
      `  guard warned ${r.guard.warned}, rewritten ${r.guard.rewritten}` +
      (r.evidence.noteWritten ? "" : "  NO NOTE WRITTEN"),
  )
  for (const [i, f] of r.firstWrites.entries()) {
    for (const h of hardViolations({ bodyMd: f.text, warnings: f.warnings }, CRITERIA_OPTS)) {
      console.log(`      first write ${i + 1} (${f.tool}) ${h.criterion}: ${h.why}`)
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

function atLeastTwoThirds(passing: number, total: number): boolean {
  return passing >= Math.ceil((2 / 3) * total)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // The judgement reads the fixture folios through the same facade the guard
  // uses, so THIS process must be on the fake cluster whatever .env.local says.
  process.env.CLUSTER_MODE = "fake"
  await requireServer()

  section("SETUP")
  const cases = selectedCases()
  const cookie = await signInCookie(EMAIL, PASSWORD, "E2E Quotes")
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })
  console.log(`  BASE_URL=${BASE_URL}  MODEL=${MODEL}  REPEAT=${REPEAT}  CONCURRENCY=${CONCURRENCY}`)
  console.log(`  cases=${cases.map((c) => c.id).join(",")}  (one fresh project per run)`)

  const jobs = cases.flatMap((c) => Array.from({ length: REPEAT }, (_, i) => ({ c, run: i + 1 })))
  const reports = await pool(jobs, CONCURRENCY, async ({ c, run }) => {
    const r = await runCase(user.id, cookie, c, run)
    console.log(`  done ${c.id} run ${run} (project ${r.projectId}, session ${r.sessionId})`)
    return r
  })

  section("RUNS")
  for (const r of reports) reportRun(r)

  section("CRITERIA")
  for (const c of cases) {
    const runs = reports.filter((r) => r.caseId === c.id)
    const verdict = casePasses(
      runs.map((r) => r.evidence),
      CRITERIA_OPTS,
    )
    check(
      `${c.id} (${c.scenario}) H1–H6 on final notes, ${runs.length}/${runs.length} runs`,
      verdict.finalOk,
      runs.map((r) => `run ${r.run}: ${list(runVerdict(r.evidence, CRITERIA_OPTS).final)}`).join(" | "),
    )
    check(
      `${c.id} (${c.scenario}) H1, H2, H6 on first writes, ≥ 2/3 runs`,
      verdict.firstWriteOk,
      `${verdict.firstWritePassing}/${runs.length} runs passing`,
    )
  }

  const c3 = reports.filter((r) => r.caseId === "C3")
  if (c3.length > 0) {
    const told = c3.filter((r) => LOW_OCR_TOLD_TO_USER.test(r.assistantText)).length
    check("S1 C3 tells the user the source is poorly recognised, ≥ 2/3 runs", atLeastTwoThirds(told, c3.length), `${told}/${c3.length}`)
  }
  const c1 = reports.filter((r) => r.caseId === "C1")
  if (c1.length > 0) {
    const split = c1.filter((r) => r.finalNotes.some((n) => citedQuoteCount(n.body) >= 2)).length
    check("S2 C1 final note has ≥ 2 distinct cited quotes, ≥ 2/3 runs", atLeastTwoThirds(split, c1.length), `${split}/${c1.length}`)
  }

  section("BASELINE SIGNAL (information)")
  const h1h2FirstWrite = reports.filter((r) => {
    const v = runVerdict(r.evidence, CRITERIA_OPTS).firstWrite
    return v.has("H1") || v.has("H2")
  })
  const warned = reports.reduce((n, r) => n + r.guard.warned, 0)
  const rewritten = reports.reduce((n, r) => n + r.guard.rewritten, 0)
  console.log(`  first-write H1/H2 failures: ${h1h2FirstWrite.length}/${reports.length} runs`)
  console.log(`    ${h1h2FirstWrite.map((r) => `${r.caseId}#${r.run}`).join(", ") || "none"}`)
  console.log(`  writes that drew quote_warnings from the server's guard: ${warned}; then rewritten: ${rewritten}`)
  console.log(`  runs that wrote no note: ${reports.filter((r) => !r.evidence.noteWritten).length}`)

  if (OUT) {
    await writeFile(OUT, JSON.stringify({ model: MODEL, repeat: REPEAT, reports }, null, 2))
    console.log(`  evidence written to ${OUT}`)
  }

  if (CLEANUP) for (const r of reports) await cleanupProject(r.projectId)
  printVerdict({ model: MODEL, runs: String(reports.length) })
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
