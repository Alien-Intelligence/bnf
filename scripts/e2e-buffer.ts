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
import { prisma } from "@/lib/db"
import { toolsForScope } from "@/lib/agent/tools"
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { noteCreateTool } from "@/lib/agent/tools/note"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { BUFFER_STATUS } from "@/models/buffer/schema"
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
  outputText,
  printVerdict,
  requireServer,
  runTurn,
  section,
  signInCookie,
  toolCalls,
  trace,
  type ChatMessage,
} from "./e2e/harness"

const E2E_EMAIL = "e2e-buffer@bnf-e2e.local"
const E2E_PASSWORD = "e2e-buffer-pw-42"

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`BnF buffer E2E\n  base=${BASE_URL}\n  model=${MODEL}\n  turnTimeout=${TURN_TIMEOUT_MS}ms`)

  // Fail fast if the server isn't up — otherwise every turn error looks like a bug.
  await requireServer()

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
  const cookie = await signInCookie(E2E_EMAIL, E2E_PASSWORD, "E2E Buffer")
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

  // --- Multi-session persistence (design §7: the buffer is project-scoped) ---
  // The tampon survives across corpus sessions: a SECOND session opened on the
  // same project must see the SAME candidates (no per-session buffer). This is a
  // pure DB invariant — no extra LLM turn — so it is cheap and deterministic.
  const secondSession = await prisma.appSession.create({
    data: {
      id: randomUUID(),
      projectId: project.id,
      scope: SESSION_SCOPE.CORPUS,
      title: "E2E second corpus session",
      status: "active",
    },
  })
  const arksFromSession1 = new Set(stagedAfterT1.map((r) => r.ark))
  const visibleToSession2 = await prisma.bufferItem.findMany({
    where: { projectId: project.id, status: BUFFER_STATUS.CANDIDATE },
    select: { ark: true },
  })
  const allVisible =
    visibleToSession2.length === arksFromSession1.size &&
    visibleToSession2.every((r) => arksFromSession1.has(r.ark))
  check(
    "B5b the buffer is project-scoped — a second session sees session-1's candidates",
    stagedAfterT1.length > 0 && allVisible,
    `session1 staged=${arksFromSession1.size} visibleFromSession2=${visibleToSession2.length} (session2=${secondSession.id})`,
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

  // --- Turn 2.5: verifiable curation (item 6's marquee scenario) -------------
  // « Il faudrait un tampon … pour curer verifiablement ». The whole point of
  // the tampon is that filtering happens on a PERSISTED, inspectable set with a
  // preview before anything is dropped — not in the model's thinking text. We
  // steer an explicit dry-run so the verifiable-before-destructive pattern is
  // exercised. Assertions are on the INVARIANT (a curation tool ran; a
  // destructive remove_by_filter was previewed first; the candidate set stays
  // valid) — NOT on which tool the agent picked, mirroring f67f379.
  const beforeCurate = callsT1.length + callsT2.length
  const candidatesBeforeCurate = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.CANDIDATE },
  })
  const curatePrompt =
    "Avant de valider, je veux affiner la sélection. Montre-moi d'abord en aperçu (dry-run) " +
    "combien de candidats seraient retirés si on excluait tout ce qui n'est PAS de l'année 1889, " +
    "puis applique ce filtrage pour ne garder que 1889."
  history.push({ role: "user", content: curatePrompt })
  console.log(`\n> TURN 2.5 (curate): ${curatePrompt}`)
  const tCurate = await runTurn(corpusSession.id, cookie, history)
  history.push({ role: "assistant", content: tCurate.text })
  console.log(`< (${Math.round(tCurate.elapsedMs / 1000)}s) ${tCurate.text.slice(0, 300)}`)

  const callsCurate = (await toolCalls(corpusSession.id)).slice(beforeCurate)
  console.log(`  tools: ${trace(callsCurate)}`)

  const removeCalls = named(callsCurate, AGENT_TOOLS.bufferRemoveByFilter)
  const discardCalls = named(callsCurate, AGENT_TOOLS.bufferDiscard)
  check(
    "B6b agent curated the buffer on request (remove_by_filter or discard)",
    removeCalls.length > 0 || discardCalls.length > 0,
    `remove_by_filter=${removeCalls.length} discard=${discardCalls.length}; used: ${trace(callsCurate)}`,
  )

  // The verifiable-before-destructive promise: a destructive remove_by_filter
  // (status:"removed" in its output) must be preceded by a dry-run preview in
  // the same turn. If the agent only previewed, or only used discard, that is
  // also acceptable — the point is that no filter-removal happened WITHOUT a
  // preview having been produced.
  const removedOutputs = removeCalls.filter((c) => outputData(c)["status"] === "removed")
  const dryRunOutputs = removeCalls.filter((c) => outputData(c)["status"] === "dry_run")
  check(
    "B6c a destructive remove_by_filter was previewed with a dry-run first",
    removedOutputs.length === 0 || dryRunOutputs.length > 0,
    `dry_run previews=${dryRunOutputs.length} destructive removals=${removedOutputs.length}`,
  )

  // Invariant: whatever the agent removed, the buffer is left in a valid state —
  // the candidate set never grows from a curation turn, discarded rows leave the
  // candidate set, and every surviving/discarded ARK is still a valid ARK.
  const candidatesAfterCurate = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.CANDIDATE },
  })
  const discardedRows = await prisma.bufferItem.findMany({
    where: { projectId: project.id, status: BUFFER_STATUS.DISCARDED },
    select: { ark: true },
  })
  const badDiscarded = discardedRows.filter((r) => !ARK_RE.test(r.ark))
  check(
    "B6d curation left the buffer valid (candidates did not grow; discards are valid ARKs)",
    candidatesAfterCurate <= candidatesBeforeCurate && badDiscarded.length === 0,
    `candidates ${candidatesBeforeCurate}→${candidatesAfterCurate}, discarded=${discardedRows.length}, badDiscarded=${badDiscarded.length}`,
  )

  // --- Turn 3: commit --------------------------------------------------------
  const t3Prompt = "Parfait, ajoute maintenant ces documents au corpus."
  history.push({ role: "user", content: t3Prompt })
  console.log(`\n> TURN 3: ${t3Prompt}`)
  const t3 = await runTurn(corpusSession.id, cookie, history)
  history.push({ role: "assistant", content: t3.text })
  console.log(`< (${Math.round(t3.elapsedMs / 1000)}s) ${t3.text.slice(0, 300)}`)

  const allCalls = await toolCalls(corpusSession.id)
  const callsT3 = allCalls.slice(beforeCurate + callsCurate.length)
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

  // --- Turn 4a: fresh line of inquiry re-populates the buffer ----------------
  // Split from the clear (Turn 4b) so the clear provably acts on a POPULATED
  // buffer: the agent is free to order tools within a turn (an earlier run did
  // clear-then-search, leaving the buffer non-empty), so we stage and clear in
  // SEPARATE turns rather than asserting an intra-turn ordering (f67f379).
  // NB: the prompt must NOT hint at "starting over / changing track" — that
  // makes the agent proactively buffer_clear BEFORE searching, then (in the next
  // turn) believe the buffer is already empty and refuse to clear the freshly
  // staged hits. Keep 4a purely additive; the clear is 4b's job alone.
  const beforeRestage = allCalls.length
  const restagePrompt =
    "Lance une recherche plein texte Gallica sur « Le Petit Journal » pour 1889 et dépose " +
    "les résultats dans le tampon. N'énumère pas les numéros ; une seule page suffit. " +
    "Ne vide pas le tampon et ne touche pas au corpus déjà constitué."
  history.push({ role: "user", content: restagePrompt })
  console.log(`\n> TURN 4a (re-stage): ${restagePrompt}`)
  const t4a = await runTurn(corpusSession.id, cookie, history)
  history.push({ role: "assistant", content: t4a.text })
  console.log(`< (${Math.round(t4a.elapsedMs / 1000)}s) ${t4a.text.slice(0, 300)}`)
  console.log(`  tools: ${trace((await toolCalls(corpusSession.id)).slice(beforeRestage))}`)

  const candidatesAfterRestage = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.CANDIDATE },
  })
  check(
    "B13 a fresh search re-populated the (post-commit empty) buffer",
    candidatesAfterRestage > 0,
    `candidates after re-stage=${candidatesAfterRestage}`,
  )

  // --- Turn 4b: clear the populated buffer -----------------------------------
  // Clearing is destructive, so the agent legitimately sometimes asks to confirm
  // before executing (the "ask is primary" steer) instead of clearing outright.
  // Both behaviours are correct UX, so the test tolerates both: pre-authorise in
  // the prompt, and if the agent still didn't clear, send ONE confirmation turn.
  // We assert the OUTCOME (the buffer got cleared), not that it happened in the
  // first turn — asserting the turn count would test the agent's caution, not
  // the feature.
  const beforeClear = (await toolCalls(corpusSession.id)).length
  const clearPrompts = [
    "Le tampon contient les candidats du Petit Journal que tu viens de déposer. Vérifie leur " +
      "nombre, puis vide entièrement le tampon maintenant avec l'outil buffer_clear, sans me " +
      "redemander. Ne touche pas au corpus déjà constitué.",
    "Oui, je confirme : appelle buffer_clear pour vider le tampon.",
  ]
  for (let attempt = 0; attempt < clearPrompts.length; attempt++) {
    const prompt = clearPrompts[attempt]
    history.push({ role: "user", content: prompt })
    console.log(`\n> TURN 4b (clear, attempt ${attempt + 1}): ${prompt}`)
    const turn = await runTurn(corpusSession.id, cookie, history)
    history.push({ role: "assistant", content: turn.text })
    console.log(`< (${Math.round(turn.elapsedMs / 1000)}s) ${turn.text.slice(0, 300)}`)
    const clearedSoFar = named(
      (await toolCalls(corpusSession.id)).slice(beforeClear),
      AGENT_TOOLS.bufferClear,
    )
    if (clearedSoFar.some((c) => c.status === "ok")) break
  }

  const callsT4 = (await toolCalls(corpusSession.id)).slice(beforeClear)
  console.log(`  tools: ${trace(callsT4)}`)

  const clearCalls = named(callsT4, AGENT_TOOLS.bufferClear)
  check(
    "B13b agent cleared the buffer on a change of inquiry",
    clearCalls.some((c) => c.status === "ok"),
    clearCalls.length === 0 ? `never cleared; used: ${trace(callsT4)}` : `${clearCalls.length} call(s)`,
  )
  // The clear must report it actually dropped the freshly-staged candidates —
  // proof it cleared a POPULATED buffer, not a no-op on an already-empty one.
  const clearedOk = clearCalls.some((c) => Number(outputData(c)["cleared"] ?? 0) > 0)
  check(
    "B13c buffer_clear reported dropping the staged candidates (cleared > 0)",
    clearedOk,
    `clear outputs: ${clearCalls.map((c) => JSON.stringify(outputData(c))).join(" | ") || "none"}`,
  )

  const candidatesAfterClear = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.CANDIDATE },
  })
  const committedAfterClear = await prisma.bufferItem.count({
    where: { projectId: project.id, status: BUFFER_STATUS.COMMITTED },
  })
  check(
    "B14 clear emptied the candidate set but preserved committed provenance",
    candidatesAfterClear === 0 && committedAfterClear === committedRows,
    `candidate=${candidatesAfterClear} committed=${committedAfterClear} (was ${committedRows})`,
  )

  // The corpus must be untouched by a buffer clear — same head version + members
  // as right after the commit (the clear is pre-commit scratch only).
  const projectAfterClear = await prisma.project.findUniqueOrThrow({ where: { id: project.id } })
  const membersAfterClear = projectAfterClear.headVersionId
    ? await prisma.corpusMembership.count({ where: { versionId: projectAfterClear.headVersionId } })
    : 0
  check(
    "B15 clear did NOT touch the committed corpus",
    projectAfterClear.headVersionId === finalProject.headVersionId && membersAfterClear === memberCount,
    `head unchanged=${projectAfterClear.headVersionId === finalProject.headVersionId} members ${memberCount}→${membersAfterClear}`,
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

  printVerdict({
    project: project.id,
    corpusSession: corpusSession.id,
    researchSession: researchSession.id,
  })

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
