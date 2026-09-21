/**
 * scripts/e2e-sessions-2026-09-15.ts — replay the BnF live-session failures.
 *
 * On 2026-09-15 a room of BnF chargés de collection used the app for an
 * afternoon. The audit of those eight sessions is in
 * ai-memories/tech/repos/bnf/session-audit-2026-09-15/. This script replays
 * their ACTUAL French messages through the real stack — real LLM, real agent
 * loop, real BnF MCP, real Postgres — and asserts on the `tool_call` rows
 * rather than on the model's prose, because the prose was fluent every time
 * and the tool calls were where the failures lived.
 *
 * Each case names the session it came from and what went wrong that day.
 *
 * Run:
 *   1. PORT=3939 npm run dev
 *   2. npm run e2e:sessions
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { ProjectService } from "@/models/projects/service"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import {
  BASE_URL,
  CLEANUP,
  MODEL,
  type ChatMessage,
  type CallRow,
  check,
  named,
  printVerdict,
  requireServer,
  runTurn,
  section,
  signInCookie,
  toolCalls,
  trace,
} from "./e2e/harness"

const EMAIL = "e2e-sessions@alien.club"
const PASSWORD = "e2e-sessions-password"

/** Phrases the agent used on 2026-09-15 to assert absence it had not established. */
const ABSENCE = [
  "aucune trace",
  "n'apparaît pas",
  "ne figure pas",
  "aucune occurrence",
  "absent des collections",
  "n'existe pas",
  "aucun résultat au catalogue",
]

/** dc.type values that return 0 (or 500) — offering one is how a zero is born. */
const DEAD_DOC_TYPES = ["typeAffiche", "son", "video", "vidéo"]

function inputOf(row: CallRow): string {
  return JSON.stringify(row.input ?? {})
}
function anyInputMatches(calls: CallRow[], re: RegExp): boolean {
  return calls.some((c) => re.test(inputOf(c)))
}
/** Totals the search tools reported, parsed out of their JSON output. */
function totalsOf(calls: CallRow[]): number[] {
  return calls.flatMap((c) => {
    const m = /"total"\s*:\s*(\d+)/.exec(JSON.stringify(c.output ?? ""))
    return m ? [Number(m[1])] : []
  })
}

async function main(): Promise<void> {
  await requireServer()

  section("SETUP")
  const cookie = await signInCookie(EMAIL, PASSWORD, "E2E Sessions")
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })
  const project = await ProjectService.create({
    name: `E2E sessions ${new Date().toISOString()}`,
    subtitle: "replay of the 2026-09-15 BnF workshop",
    ownerId: user.id,
  })
  console.log(`  BASE_URL=${BASE_URL}  MODEL=${MODEL}`)
  console.log(`  project=${project.id}`)

  async function replay(
    label: string,
    messages: string[],
  ): Promise<{ calls: CallRow[]; text: string }> {
    const session = await prisma.appSession.create({
      data: {
        id: randomUUID(),
        projectId: project.id,
        scope: SESSION_SCOPE.CORPUS,
        title: label,
        status: "active",
      },
    })
    const history: ChatMessage[] = []
    let text = ""
    for (const msg of messages) {
      history.push({ role: "user", content: msg })
      const turn = await runTurn(session.id, cookie, history)
      if (turn.errors.length > 0) {
        console.log(`  ⚠ turn errors: ${turn.errors.join("; ").slice(0, 200)}`)
      }
      history.push({ role: "assistant", content: turn.text })
      text += `\n${turn.text}`
    }
    const calls = await toolCalls(session.id)
    console.log(`  trace: ${trace(calls)}`)
    return { calls, text }
  }

  const searchOf = (calls: CallRow[]): CallRow[] => [
    ...named(calls, "corpus_search"),
    ...named(calls, "bnf__bnf_search_gallica"),
    ...named(calls, "bnf__bnf_search_catalogue"),
  ]

  // =========================================================================
  section("CASE 1 — f83d8d37 · the false absence that reached a librarian")
  // On 2026-09-15 the agent replied « Cadoricin — aucune trace au catalogue ni
  // sur Gallica » while its own tool output held total:4 and total:236, then
  // wrote that falsehood to project memory.
  // =========================================================================
  {
    const { calls, text } = await replay("case1-marques", [
      "je cherche des ouvrages et des revues sur les marques de produits de beauté " +
        "suivantes : Cadoricin, Cadonett, Mixa, DOP. Dis-moi ce que la BnF possède.",
    ])
    const searches = searchOf(calls)

    // The 2026-09-15 incident was NOT "the agent said the word absent". It was
    // an absence claim CONTRADICTED BY ITS OWN TOOL OUTPUT: « Cadoricin —
    // aucune trace au catalogue ni sur Gallica » while total:236 sat in the
    // response. A scoped, true statement ("the metadata index holds none of
    // these, let me try the press") is the behaviour we want, so match on the
    // contradiction, not on the vocabulary.
    const contradicted = ["Cadoricin", "Cadonett", "Mixa", "DOP"].filter((brand) => {
      const claimsAbsent = ABSENCE.some((p) => {
        const i = text.toLowerCase().indexOf(p)
        return i >= 0 && text.slice(Math.max(0, i - 260), i + 260).includes(brand)
      })
      if (!claimsAbsent) return false
      // Did any search in this session find that brand anyway?
      return searches.some((c) => {
        if (!new RegExp(brand, "i").test(inputOf(c))) return false
        const m = /"total"\s*:\s*(\d+)/.exec(JSON.stringify(c.output ?? ""))
        return m !== null && Number(m[1]) > 0
      })
    })
    check(
      "1a no absence claim contradicted by its own tool output",
      contradicted.length === 0,
      contradicted.length === 0
        ? "any absence statement was scoped to the index actually searched"
        : `claimed absent despite own non-zero totals: ${contradicted.join(", ")}`,
    )
    check(
      "1b searched the bare brand term",
      anyInputMatches(searches, /"(query|cql)"\s*:\s*"[^"]*Cadoricin[^"]*"/i),
      `${searches.length} searches`,
    )
    const zeros = totalsOf(searches).filter((t) => t === 0).length
    check(
      "1c did not leave every brand on a zero",
      zeros < searches.length,
      `${zeros}/${searches.length} searches returned 0`,
    )
  }

  // =========================================================================
  section("CASE 2 — ab1d77a9 · named person, author index never used")
  // That day: three bare `query: "Francis Jourdain"` free-text calls, `creator`
  // never used, 199 candidates staged of which ~40 had no link to Jourdain.
  // =========================================================================
  {
    // The terse opener legitimately draws a clarifying `ask_user`, so answer it
    // the way the librarian would and assert on the search that follows.
    const { calls } = await replay("case2-jourdain", [
      "francis jourdain décorateur",
      "Ses propres écrits et les ouvrages qui parlent de lui. Toutes périodes.",
    ])
    const searches = searchOf(calls)

    check(
      "2a used a field/metadata index, not bare free text",
      anyInputMatches(searches, /"(creator|author)"\s*:|dc\.creator|bib\.author|metadata all/i),
      `inputs: ${searches.map(inputOf).join(" | ").slice(0, 220)}`,
    )
    check(
      "2b did not append the descriptive word to a catalogue query",
      !anyInputMatches(
        searches.filter((c) => /catalogue/.test(inputOf(c))),
        /"query"\s*:\s*"[^"]*décorateur/i,
      ),
      "descriptive words zero out a metadata-only index",
    )
  }

  // =========================================================================
  section("CASE 3 — 41400f04 · 13 searches, zero date constraints, ~3.5% on topic")
  // =========================================================================
  {
    const { calls } = await replay("case3-expo1925", [
      "Je cherche des pavillons pouvant être liés à la parfumerie construits pour " +
        "l'Exposition internationale des arts décoratifs de 1925.",
    ])
    const searches = searchOf(calls)

    check(
      "3a constrained the search (date and/or doc_type)",
      anyInputMatches(searches, /"date|dc\.date|"doc_type"|dc\.type/i),
      `${searches.length} searches`,
    )
    check(
      "3b reached for the doc_type lane split",
      anyInputMatches(searches, /"doc_type"|dc\.type/i),
      "only dc.type removes periodical collection records",
    )
  }

  // =========================================================================
  section("CASE 4 — the librarians' explicit asks: cote and proximity")
  // Neither was expressible before 0.4.0. `cotes` is what they asked for by name.
  // =========================================================================
  {
    const { calls } = await replay("case4-cote-prox", [
      "Je cherche la notice correspondant à la cote RES P-YF-3.",
      "Maintenant trouve-moi des documents où le mot « sentiment » apparaît à moins " +
        "de trois mots de « amoureux ».",
    ])
    const searches = searchOf(calls)

    check(
      "4a shelfmark routed to the cote index",
      anyInputMatches(searches, /"shelfmark"|bib\.cote|dc\.source/i),
      inputOf(searches[0] ?? ({ input: {} } as CallRow)).slice(0, 160),
    )
    check(
      "4b proximity actually issued",
      anyInputMatches(searches, /prox\/unit=word/),
      "explicit proximity request must produce a prox clause",
    )
  }

  // =========================================================================
  section("CROSS-CUTTING — invariants that must hold across every case")
  // =========================================================================
  {
    // Select `error` too: every helper below takes a CallRow, and the shared
    // harness reads the column. Omitting it here made this whole block a
    // structural mismatch that only a cast was hiding.
    const all = (await prisma.toolCall.findMany({
      where: { message: { appSession: { projectId: project.id } } },
      select: { tool: true, status: true, input: true, output: true, error: true },
    })) as CallRow[]
    const searches = all.filter((c) => /search/.test(c.tool))

    const deadUsed = DEAD_DOC_TYPES.filter((d) =>
      searches.some((c) => new RegExp(`"${d}"`).test(inputOf(c))),
    )
    check(
      "X1 never used a dead dc.type value",
      deadUsed.length === 0,
      deadUsed.length === 0 ? "none offered, none used" : `used: ${deadUsed.join(", ")}`,
    )

    // A refusal is a SUCCESS of the validator: the query was unexpressible and
    // was stopped before it could come back as a zero the agent reads as
    // absence. Only a hard schema failure — the tool rejecting its own input —
    // is a defect. `ask_user` blowing its 160-char cap is the bug that produced
    // "Ploum ploum tralala" in session 38e3c60d: the widget never renders and
    // the librarian is left facing a dead interface.
    // Read the tool's own text, NOT JSON.stringify of the row: the output is
    // {content: "Tool \"ask_user\" failed: …"} and stringify re-escapes those
    // quotes, so a regex written against the readable form silently matches
    // nothing. That made this assertion pass while two ask_user failures sat in
    // the same run.
    const outText = (c: CallRow): string => {
      const o = c.output as { content?: unknown } | null
      return typeof o?.content === "string" ? o.content : JSON.stringify(c.output ?? "")
    }
    const errored = all.filter((c) => c.status === "error")
    const refusals = errored.filter((c) => /"refused"\s*:\s*true/.test(outText(c)))
    const schemaFailures = errored.filter((c) => /Tool "[^"]+" failed:/.test(outText(c)))
    const upstream500s = errored.filter((c) => /HTTP 5\d\d/.test(outText(c)))

    check(
      "X4 no upstream 5xx reached the agent",
      upstream500s.length === 0,
      upstream500s.length === 0
        ? "none"
        : upstream500s
            .map((c) => `${c.tool} ${inputOf(c).slice(0, 90)}`)
            .join(" | "),
    )
    console.log(
      `  (${refusals.length} validator refusal(s) — those are the feature, not a fault)`,
    )
    check(
      "X2 no tool rejected its own input",
      schemaFailures.length === 0,
      schemaFailures.length === 0
        ? "no schema failures"
        : schemaFailures.map((e) => e.tool).join(", "),
    )

    // A zero is allowed; a zero with no explanation is the incident.
    const bareZeros = searches.filter((c) => {
      const out = JSON.stringify(c.output ?? "")
      return /"total"\s*:\s*0\b/.test(out) && !/zero_result/.test(out)
    })
    check(
      "X3 every zero carried its zero_result explanation",
      bareZeros.length === 0,
      bareZeros.length === 0 ? "no bare zeros" : `${bareZeros.length} bare zero(s)`,
    )
  }

  if (CLEANUP) await cleanupProject(project.id)
  printVerdict({ project: project.id, model: MODEL })
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
