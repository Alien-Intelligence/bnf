/**
 * scripts/audit-note-quotes.ts — measure quote fidelity in EXISTING notes.
 *
 * The note-tool guard checks only what an agent writes from now on. This
 * script runs the same check (lib/citations/quote-check.ts) over notes already
 * in the database — every quote of every note, against the ingested text of
 * the folio it cites — and prints how many quotes break each rule, with up to
 * five excerpts per rule.
 *
 * Read-only: it never writes a note, a citation or any other row. It is a
 * measurement, not a gate: it exits 0 whatever it finds, and non-zero only
 * when it cannot measure (bad arguments, a database or unexpected error).
 * The cluster it reads is whatever CLUSTER_MODE selects, through the same
 * read path the agent uses; on prod it is run only with Leo's go-ahead.
 *
 * Run:
 *   npm run audit:quotes -- <projectId>
 *   npm run audit:quotes -- --all
 */
import { prisma } from "@/lib/db"
import { corpusProjectId } from "@/lib/authz/corpus-source"
import { checkNoteQuotes } from "@/lib/citations/quote-check"
import { QUOTE_CHECK_BUDGET_MS } from "@/lib/constants"
import type { QuoteWarning } from "@/models/notes/schema"

const EXCERPTS_PER_REASON = 5
const USAGE = "usage: npm run audit:quotes -- <projectId> | --all"

type Target = { all: true } | { all: false; projectId: string }

function parseArgs(argv: readonly string[]): Target {
  if (argv.length !== 1) throw new Error(USAGE)
  const [arg] = argv
  if (arg === "--all") return { all: true }
  if (arg.startsWith("-")) throw new Error(USAGE)
  return { all: false, projectId: arg }
}

/** A warning's bucket: the reason, plus the cause for `unverifiable`. */
function bucketOf(w: QuoteWarning): string {
  return w.cause === undefined ? w.reason : `${w.reason}/${w.cause}`
}

async function main(): Promise<void> {
  const target = parseArgs(process.argv.slice(2))

  const projects = await prisma.project.findMany({
    where: target.all ? {} : { id: target.projectId },
    select: { id: true, name: true, corpusSourceId: true, corpusSourceShareId: true },
    orderBy: { createdAt: "asc" },
  })
  if (!target.all && projects.length === 0) throw new Error(`no project with id ${target.projectId}`)

  let notesSeen = 0
  let quotesChecked = 0
  let notesPartial = 0
  const counts = new Map<string, number>()
  const excerpts = new Map<string, string[]>()

  for (const project of projects) {
    const notes = await prisma.note.findMany({
      where: { projectId: project.id },
      select: { id: true, title: true, body_md: true },
      orderBy: { createdAt: "asc" },
    })
    if (notes.length === 0) continue
    console.log(`\n${project.name} (${project.id}) — ${notes.length} note(s)`)

    for (const note of notes) {
      notesSeen++
      const res = await checkNoteQuotes({
        corpusProjectId: corpusProjectId(project),
        bodyMd: note.body_md,
        priorBodyMd: null,
        signal: new AbortController().signal,
        // No per-folio quality index in this build: reported as unevaluated.
        lowOcrFolios: null,
        budgetMs: QUOTE_CHECK_BUDGET_MS,
      })
      quotesChecked += res.checked
      if (res.status !== "complete") notesPartial++
      console.log(`  ${note.id.slice(0, 8)} ${res.checked} quote(s), ${res.warnings.length} warning(s) — ${note.title}`)
      for (const w of res.warnings) {
        const bucket = bucketOf(w)
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
        const list = excerpts.get(bucket) ?? []
        if (list.length < EXCERPTS_PER_REASON) {
          const where = w.citation ? `${w.citation.ark} f${w.citation.folio}` : "uncited"
          const found = w.found_on_folio === undefined ? "" : ` (found on f${w.found_on_folio})`
          list.push(`note ${note.id.slice(0, 8)} · ${where}${found} · « ${w.quote} »`)
          excerpts.set(bucket, list)
        }
      }
    }
  }

  console.log(`\n${"=".repeat(72)}\nQUOTE AUDIT`)
  console.log(`projects: ${projects.length}  notes: ${notesSeen}  quotes checked: ${quotesChecked}`)
  console.log(`notes with an unverifiable quote: ${notesPartial}`)
  if (counts.size === 0) {
    console.log("no warnings")
    return
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const width = Math.max(...rows.map(([k]) => k.length))
  for (const [bucket, n] of rows) console.log(`  ${bucket.padEnd(width)}  ${n}`)
  for (const [bucket] of rows) {
    console.log(`\n${bucket}`)
    for (const e of excerpts.get(bucket) ?? []) console.log(`  - ${e}`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
