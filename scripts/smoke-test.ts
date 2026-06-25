/**
 * scripts/smoke-test.ts — BnF Corpus Research smoke test.
 *
 * Run via:  npm run smoke
 * Which executes: tsx --conditions react-server scripts/smoke-test.ts
 *   (--conditions react-server makes `server-only` resolve to the empty shim
 *   so we can import service modules that guard against client bundling.)
 *
 * Required environment variables (loaded from .env.local by tsx --env-file-if-exists):
 *   DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, ANTHROPIC_API_KEY
 *
 * Exercises three invariants:
 *   1. Advisory lock + monotonic seq — two concurrent addArks calls on the
 *      same project must produce strictly monotonic seqs without gaps.
 *   2. No-op delta short-circuit — addArks with all-existing ARKs must not
 *      create a new corpus_version row.
 *   3. better-auth round-trip — signUpEmail + signInEmail returns a session
 *      token; treats USER_ALREADY_EXISTS as a previous-run survivor
 *      (idempotency).
 *
 * Idempotent: re-running succeeds without manual cleanup.
 * Exits 0 on full success, 1 on any assertion failure.
 */

// ---------------------------------------------------------------------------
// Imports — these trigger lib/env.ts and lib/db.ts, which read DATABASE_URL
// and other vars at module-init time. The tsx --env-file-if-exists flag
// (set in the npm script) loads .env.local before ESM hoisting fires.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { ProjectService } from "@/models/projects/service"
import { DocumentService } from "@/models/documents/service"
import { CorpusService } from "@/models/corpus/service"
import { CorpusQueries } from "@/models/corpus/queries"
import type { User } from "@/models/users/schema"
import { parseBnfDate, normalizeDocument, normalizeMany } from "@/lib/mcp/normalize"
import { mapCatalogueDocType, sourceFromArk } from "@/lib/mcp/vocab"
import { runReaperCycle } from "@/lib/agent/runtime/reaper"
import { IngestService } from "@/models/ingest/service"
import { INGEST_STATUS } from "@/models/ingest/schema"
import { NoteService } from "@/models/notes/service"

// ---------------------------------------------------------------------------
// Stable smoke-owner email — same across runs so the user survives re-runs.
// Idempotency: if it already exists we fetch it; if not we create it.
// Cleaned up at the end of every successful run.
// ---------------------------------------------------------------------------
const SMOKE_OWNER_EMAIL = "smoke-owner@bnf-smoke.local"
const SMOKE_OWNER_PASSWORD = "smoke-owner-pw-42"

// ---------------------------------------------------------------------------
// Error helpers (mirrors the pattern in prisma/seed.ts)
// ---------------------------------------------------------------------------
function isEmailAlreadyExistsError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  if (
    typeof e["body"] === "object" &&
    e["body"] !== null &&
    (e["body"] as Record<string, unknown>)["code"] ===
      "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
  ) {
    return true
  }
  return e["status"] === "UNPROCESSABLE_ENTITY"
}

// ---------------------------------------------------------------------------
// Global test state — accumulates across tests; all cleaned up in finally.
// ---------------------------------------------------------------------------
let smokeUser: User | null = null
let smokeProjectId: string | null = null
let smokeDocArks: string[] = []

// ---------------------------------------------------------------------------
// Delete one smoke project and all its dependent rows.
//
// Deletion order must respect FK constraints (no CASCADE on all FKs):
//   corpus_membership → corpus_version → document → project
// ---------------------------------------------------------------------------
async function deleteProject(projectId: string): Promise<void> {
  await prisma.corpusMembership.deleteMany({ where: { projectId } })
  await prisma.corpusVersion.deleteMany({ where: { projectId } })
  // Contributions reference both document and app_session; drop them before the
  // documents (FK) and before any session rows the test created.
  await prisma.corpusContribution.deleteMany({ where: { projectId } })
  await prisma.appSession.deleteMany({ where: { projectId } })
  await prisma.document.deleteMany({ where: { projectId } })
  // headVersionId is @unique and references a now-deleted corpus_version row;
  // null it out before deleting the project to satisfy the FK check.
  await prisma.project.update({
    where: { id: projectId },
    data: { headVersionId: null, ingestedVersionId: null },
  })
  await prisma.project.delete({ where: { id: projectId } })
}

// ---------------------------------------------------------------------------
// Cleanup — runs unconditionally at the end (success OR failure).
//
// The smoke-owner user is a stable test account — we do NOT delete it on each
// run so that idempotency works: the user survives re-runs and is only absent
// on a fresh DB. Any projects owned by it (current run's or orphaned from a
// prior failed run) are fully deleted.
// ---------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  if (smokeUser !== null) {
    // Delete ALL projects owned by the smoke user (current run + any orphans
    // from prior failed runs). This handles the case where a previous run's
    // cleanup failed mid-way and left a dangling project row.
    try {
      const orphanedProjects = await prisma.project.findMany({
        where: { ownerId: smokeUser.id },
        select: { id: true },
      })
      for (const { id } of orphanedProjects) {
        try {
          await deleteProject(id)
        } catch (err: unknown) {
          console.error(`  ⚠ cleanup: project ${id} delete failed (non-fatal):`, err)
        }
      }
      smokeProjectId = null
      smokeDocArks = []
    } catch (err: unknown) {
      console.error("  ⚠ cleanup: listing orphaned projects failed (non-fatal):", err)
    }

    // Delete the stable smoke-owner user now that all its projects are gone.
    try {
      await prisma.user.delete({ where: { id: smokeUser.id } })
      smokeUser = null
    } catch (err: unknown) {
      console.error("  ⚠ cleanup: smoke user delete failed (non-fatal):", err)
    }
  }
}

// ---------------------------------------------------------------------------
// Setup — ensure a real user row exists for the project FK constraint.
// Uses a stable email so the user survives re-runs.
// ---------------------------------------------------------------------------
async function setupSmokeUser(): Promise<User> {
  // Try signup first (first run creates it).
  try {
    await auth.api.signUpEmail({
      body: {
        email: SMOKE_OWNER_EMAIL,
        password: SMOKE_OWNER_PASSWORD,
        name: "Smoke Owner",
      },
    })
    console.log("  ✓ smoke owner user created")
  } catch (err: unknown) {
    if (isEmailAlreadyExistsError(err)) {
      console.log("  ✓ smoke owner user already exists — reusing")
    } else {
      throw err
    }
  }

  // Fetch the Prisma row (betterAuth returns a session object, not the full row).
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: SMOKE_OWNER_EMAIL },
  })
  return user
}

// ---------------------------------------------------------------------------
// Test 1: Advisory lock + monotonic seq
// ---------------------------------------------------------------------------
async function testAdvisoryLockMonotonicSeq(owner: User): Promise<void> {
  console.log("\nTest 1: advisory lock + monotonic seq")

  // --- Create a dedicated test project ------------------------------------
  const project = await ProjectService.create({
    name: `Smoke Test Project ${randomUUID()}`,
    ownerId: owner.id,
  })
  smokeProjectId = project.id

  // --- Verify the initial head (seq=1) -------------------------------------
  const initialVersions = await prisma.corpusVersion.findMany({
    where: { projectId: project.id },
    orderBy: { seq: "asc" },
  })
  assert.equal(
    initialVersions.length,
    1,
    "Expected exactly one version after project creation",
  )
  const initialSeq = initialVersions[0]!.seq
  assert.equal(initialSeq, 1, "Initial seq must be 1 (invariant 1)")

  // --- Create Document rows for two non-overlapping ARK sets ---------------
  const setA = [
    `ark:/12148/smoketest-${randomUUID()}`,
    `ark:/12148/smoketest-${randomUUID()}`,
  ]
  const setB = [
    `ark:/12148/smoketest-${randomUUID()}`,
    `ark:/12148/smoketest-${randomUUID()}`,
  ]
  smokeDocArks = [...setA, ...setB]

  await DocumentService.upsertMany(project.id, [
    ...setA.map((ark) => ({
      ark,
      title: `Smoke A – ${ark}`,
      docType: "monographie",
      rawMetadata: {},
    })),
    ...setB.map((ark) => ({
      ark,
      title: `Smoke B – ${ark}`,
      docType: "monographie",
      rawMetadata: {},
    })),
  ])

  // --- Fire two concurrent addArks on the SAME project --------------------
  // Promise.all fires both calls simultaneously. The advisory lock inside
  // CorpusService.addArks (pg_advisory_xact_lock) serialises them so each
  // transaction reads a consistent head seq before incrementing.
  const [resultA, resultB] = await Promise.all([
    CorpusService.addArks(project, owner, { arks: setA, reason: "smoke-lock-A" }),
    CorpusService.addArks(project, owner, { arks: setB, reason: "smoke-lock-B" }),
  ])

  // --- Assert monotonic seqs with no gap -----------------------------------
  const versions = await prisma.corpusVersion.findMany({
    where: { projectId: project.id },
    orderBy: { seq: "asc" },
    select: { seq: true },
  })

  // seq=1 (initial empty) + seq=2 + seq=3 (one per addArks call)
  assert.equal(
    versions.length,
    3,
    `Expected 3 corpus_version rows, got ${versions.length}`,
  )
  const seqs = versions.map((v) => v.seq)
  assert.deepEqual(
    seqs,
    [1, 2, 3],
    `Seqs must be strictly monotonic [1,2,3], got ${JSON.stringify(seqs)}`,
  )

  // The two concurrent calls must have landed on different seqs (no collision).
  assert.notEqual(
    resultA.versionSeq,
    resultB.versionSeq,
    "Two concurrent addArks must produce different versionSeqs",
  )

  console.log(
    `  seqs after concurrent adds: ${seqs.join(", ")} — no gap, strictly monotonic`,
  )
  console.log(
    `  concurrent call seqs: ${resultA.versionSeq} and ${resultB.versionSeq} — distinct`,
  )
}

// ---------------------------------------------------------------------------
// Test 2: No-op delta short-circuit
// ---------------------------------------------------------------------------
async function testNoOpDeltaShortCircuit(owner: User): Promise<void> {
  console.log("\nTest 2: no-op delta short-circuit")

  // Reuse the project from Test 1 (head is now at seq=3, both ARK sets added).
  assert.ok(smokeProjectId !== null, "smokeProjectId must be set from Test 1")

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: smokeProjectId },
  })

  // Count corpus_version rows before the no-op call.
  const beforeCount = await prisma.corpusVersion.count({
    where: { projectId: project.id },
  })

  // Pre-call head seq — read directly from DB for a clean assertion.
  const headBefore = await prisma.corpusVersion.findFirstOrThrow({
    where: { projectId: project.id },
    orderBy: { seq: "desc" },
    select: { seq: true },
  })
  const preCallHeadSeq = headBefore.seq

  // All ARKs in smokeDocArks are already members of the head version.
  const result = await CorpusService.addArks(project, owner, {
    arks: smokeDocArks,
    reason: "noop-test",
  })

  // Count corpus_version rows after the no-op call.
  const afterCount = await prisma.corpusVersion.count({
    where: { projectId: project.id },
  })

  assert.equal(
    afterCount,
    beforeCount,
    `No-op addArks must not create a new corpus_version row (before=${beforeCount}, after=${afterCount})`,
  )

  assert.equal(
    result.versionSeq,
    preCallHeadSeq,
    `No-op result.versionSeq must equal pre-call head seq (${preCallHeadSeq}), got ${result.versionSeq}`,
  )

  console.log(
    `  corpus_version rows: before=${beforeCount}, after=${afterCount} — unchanged`,
  )
  console.log(
    `  returned versionSeq=${result.versionSeq} (pre-call head was ${preCallHeadSeq}) — no advance`,
  )
}

// ---------------------------------------------------------------------------
// Test 3: better-auth round-trip
// ---------------------------------------------------------------------------
async function testBetterAuthRoundTrip(): Promise<void> {
  console.log("\nTest 3: better-auth round-trip")

  // Use a fresh per-run email so this test is independent of the stable
  // smoke-owner account (and so re-runs don't collide on the per-run UUID).
  const email = `smoketest-${randomUUID()}@example.com`
  const password = "smoke-test-pw-999"

  // --- Sign up --------------------------------------------------------------
  // On first run: creates the user. On re-run before cleanup: treats the
  // duplicate-email error as an idempotency signal and proceeds to sign in.
  try {
    await auth.api.signUpEmail({
      body: { email, password, name: "Smoke Test User" },
    })
    console.log(`  ✓ signUpEmail succeeded for ${email}`)
  } catch (err: unknown) {
    if (isEmailAlreadyExistsError(err)) {
      console.log(`  ✓ signUpEmail: user already exists (idempotency path) — proceeding to signIn`)
    } else {
      throw err
    }
  }

  // --- Sign in and verify a session token is returned ----------------------
  const signInResult = await auth.api.signInEmail({
    body: { email, password },
  })

  assert.ok(signInResult, "signInEmail must return a result object")
  assert.ok(
    typeof signInResult.token === "string" && signInResult.token.length > 0,
    `signInEmail must return a non-empty token, got: ${JSON.stringify(signInResult.token)}`,
  )

  console.log(`  ✓ signInEmail returned token (length=${signInResult.token.length})`)

  // --- Cleanup: delete the per-run test user --------------------------------
  try {
    await prisma.user.delete({ where: { email } })
    console.log(`  ✓ per-run test user deleted`)
  } catch (err: unknown) {
    console.error("  ⚠ per-run test user delete failed (non-fatal):", err)
  }
}

// ---------------------------------------------------------------------------
// Test 4: parseBnfDate fixtures (pure, no DB)
// ---------------------------------------------------------------------------
function testParseBnfDateFixtures(): void {
  console.log("\nTest 4: parseBnfDate fixtures")

  // null / undefined / empty → { year: null, label: null }
  assert.deepEqual(parseBnfDate(null), { year: null, label: null }, "null input")
  assert.deepEqual(parseBnfDate(undefined), { year: null, label: null }, "undefined input")
  assert.deepEqual(parseBnfDate(""), { year: null, label: null }, "empty string")
  assert.deepEqual(parseBnfDate("  "), { year: null, label: null }, "whitespace-only string")

  // Exact 4-digit year → { year: N, label: null }
  assert.deepEqual(parseBnfDate("1862"), { year: 1862, label: null }, "exact year 1862")

  // Approximate year variants (case-insensitive)
  assert.deepEqual(parseBnfDate("vers 1890"), { year: 1890, label: "vers 1890" }, "vers 1890")
  assert.deepEqual(parseBnfDate("circa 1890"), { year: 1890, label: "vers 1890" }, "circa 1890")
  assert.deepEqual(parseBnfDate("ca 1890"), { year: 1890, label: "vers 1890" }, "ca 1890")
  assert.deepEqual(parseBnfDate("ca. 1890"), { year: 1890, label: "vers 1890" }, "ca. 1890")
  assert.deepEqual(parseBnfDate("VERS 1890"), { year: 1890, label: "vers 1890" }, "VERS 1890 (case-insensitive)")

  // Year ranges with various separators → first year, en-dash label
  assert.deepEqual(parseBnfDate("1850-1860"), { year: 1850, label: "1850–1860" }, "range hyphen")
  assert.deepEqual(parseBnfDate("1850–1860"), { year: 1850, label: "1850–1860" }, "range en-dash")
  assert.deepEqual(parseBnfDate("1850/1860"), { year: 1850, label: "1850–1860" }, "range slash")

  // Century strings → { year: null, label: "XIXe siècle" }
  assert.deepEqual(parseBnfDate("XIXe siècle"), { year: null, label: "XIXe siècle" }, "XIXe siècle")
  assert.deepEqual(parseBnfDate("XIXème siècle"), { year: null, label: "XIXe siècle" }, "XIXème siècle")
  assert.deepEqual(parseBnfDate("XIX siècle"), { year: null, label: "XIXe siècle" }, "XIX siècle (no suffix)")

  // Unhandled free-text → { year: null, label: raw preserved }
  assert.deepEqual(parseBnfDate("environ 1900"), { year: null, label: "environ 1900" }, "environ 1900 (unhandled → raw preserved)")

  console.log("  ✓ parseBnfDate fixtures")
}

// ---------------------------------------------------------------------------
// Test 5: mapCatalogueDocType + normalizeDocument mapping fixtures (pure, no DB)
// ---------------------------------------------------------------------------
function testDocTypeMappingFixtures(): void {
  console.log("\nTest 5: mapCatalogueDocType + normalizeDocument mapping fixtures")

  // mapCatalogueDocType
  assert.equal(mapCatalogueDocType("Périodique"), "press", "Périodique → press")
  assert.equal(mapCatalogueDocType("presse quotidienne"), "press", "presse quotidienne → press")
  assert.equal(mapCatalogueDocType("Texte imprimé"), "book", "Texte imprimé → book")
  assert.equal(mapCatalogueDocType("Livre numérique"), "book", "Livre numérique → book")
  assert.equal(mapCatalogueDocType("Carte plan"), "map", "Carte plan → map")
  assert.equal(mapCatalogueDocType("Manuscrit"), "manuscript", "Manuscrit → manuscript")
  assert.equal(mapCatalogueDocType("Estampe"), "image", "Estampe → image")
  assert.equal(mapCatalogueDocType("foobar"), null, "foobar → null (unmatched)")

  // normalizeDocument — Gallica fascicule (full ARK, known Gallica prefix)
  const gallicaPayload = {
    ark: "ark:/12148/bpt6k5738219s",
    title: "T",
    doc_type: "fascicule",
    language: "fre",
    date: "1889",
  }
  const gallicaDoc = normalizeDocument(gallicaPayload)
  assert.ok(gallicaDoc !== null, "gallicaDoc must not be null")
  assert.equal(gallicaDoc.docType, "press", "fascicule → press")
  assert.equal(gallicaDoc.lang, "fr", "fre → fr")
  assert.equal(gallicaDoc.year, 1889, "date 1889 → year 1889")
  assert.equal(gallicaDoc.source, "gallica", "bpt6k prefix → gallica")
  assert.ok(
    typeof gallicaDoc.iiifManifestUrl === "string" && gallicaDoc.iiifManifestUrl.length > 0,
    "iiifManifestUrl must be non-null for gallica source",
  )

  // normalizeDocument — Catalogue short-form ARK (cb prefix, no ark:/12148/ prefix)
  const cataloguePayload = {
    ark: "cb314727618",
    title: "T",
    doc_type: "Périodique",
    language: "fre",
    date: "circa 1890",
  }
  const catalogueDoc = normalizeDocument(cataloguePayload)
  assert.ok(catalogueDoc !== null, "catalogueDoc must not be null")
  assert.equal(catalogueDoc.ark, "ark:/12148/cb314727618", "short-form ark gets ark:/12148/ prefix")
  assert.equal(catalogueDoc.docType, "press", "Périodique → press")
  assert.equal(catalogueDoc.year, 1890, "circa 1890 → year 1890")
  assert.equal(catalogueDoc.dateLabel, "vers 1890", "circa 1890 → dateLabel 'vers 1890'")
  assert.equal(catalogueDoc.source, "catalogue", "cb prefix → catalogue")
  assert.equal(catalogueDoc.iiifManifestUrl, null, "iiifManifestUrl must be null for catalogue")

  console.log("  ✓ mapCatalogueDocType + normalizeDocument mapping fixtures")
}

// ---------------------------------------------------------------------------
// Test 6: sourceFromArk fixtures (pure, no DB)
// ---------------------------------------------------------------------------
function testSourceFromArkFixtures(): void {
  console.log("\nTest 6: sourceFromArk fixtures")

  // Gallica prefixes (full ARK form)
  assert.equal(sourceFromArk("ark:/12148/bpt6k5738219s"), "gallica", "bpt6k → gallica")
  assert.equal(sourceFromArk("ark:/12148/btv1b10500001g"), "gallica", "btv1b → gallica")
  assert.equal(sourceFromArk("ark:/12148/bd6t5738219s"), "gallica", "bd6t → gallica")

  // Catalogue prefix — short form and full ARK form
  assert.equal(sourceFromArk("cb314727618"), "catalogue", "cb short form → catalogue")
  assert.equal(sourceFromArk("ark:/12148/cb314727618"), "catalogue", "cb full ARK → catalogue")

  // databnf (semantic-tools temporary URI)
  assert.equal(sourceFromArk("temp-work/abcdef/"), "databnf", "temp-work/ → databnf")

  console.log("  ✓ sourceFromArk fixtures")
}

// ---------------------------------------------------------------------------
// Test 7: normalizeMany rejection (drops temp-work + title-less) (pure, no DB)
// ---------------------------------------------------------------------------
function testNormalizeManyRejection(): void {
  console.log("\nTest 7: normalizeMany rejection")

  const validDoc = {
    ark: "ark:/12148/bpt6k5738219s",
    title: "Le Figaro",
    doc_type: "fascicule",
    language: "fre",
    date: "1889",
  }
  // Missing both title and creator — must be dropped
  const titlelessDoc = {
    ark: "ark:/12148/bpt6k0000001z",
    // no title, no creator
    doc_type: "fascicule",
    language: "fre",
    date: "1900",
  }
  // temp-work/ URI — source resolves to "databnf" and must be dropped
  const tempWorkDoc = {
    ark: "temp-work/abcdef/",
    title: "Some temp record",
    doc_type: "monographie",
    language: "fre",
    date: "2020",
  }

  const results = normalizeMany([validDoc, titlelessDoc, tempWorkDoc])

  assert.equal(
    results.length,
    1,
    `normalizeMany must drop the titleless and temp-work records; expected 1, got ${results.length}`,
  )
  assert.equal(
    results[0]?.ark,
    "ark:/12148/bpt6k5738219s",
    "The surviving record must be the valid Gallica doc",
  )

  console.log("  ✓ normalizeMany rejection")
}

// ---------------------------------------------------------------------------
// Test 8: Reaper — orphaned streaming message is reaped in one cycle
//
// Simulates a server-restart scenario:
//   - Insert a fake "streaming" Message with an old startedAt (no registry entry).
//   - Call runReaperCycle() directly (no wait needed — no interval).
//   - Assert the message status changed to "error" and activeMessageId cleared.
//   - Cleans up after itself.
// ---------------------------------------------------------------------------
async function testReaperOrphanRecovery(owner: User): Promise<void> {
  console.log("\nTest 8: reaper orphan recovery")

  // --- Create project + session scaffolding ---------------------------------
  const project = await ProjectService.create({
    name: `Smoke Reaper Project ${randomUUID()}`,
    ownerId: owner.id,
  })

  const session = await prisma.appSession.create({
    data: {
      projectId: project.id,
      scope: "corpus",
      title: "Smoke reaper session",
    },
  })

  // Insert an orphaned assistant message — status "streaming", old startedAt,
  // NOT registered in TurnRegistry (simulates a server restart mid-turn).
  const orphanedMsg = await prisma.message.create({
    data: {
      appSessionId: session.id,
      seq: 1,
      role: "assistant",
      content: "",
      status: "streaming",
      // Backdated well past TURN_REAP_TTL_MS (30 min) to be safe,
      // though the DB reaper ignores TTL — it reaps any unregistered streaming row.
      startedAt: new Date(Date.now() - 35 * 60 * 1_000),
    },
  })

  // Point the session at this message (activeMessageId) so we can also verify
  // the session pointer is cleared.
  await prisma.appSession.update({
    where: { id: session.id },
    data: { activeMessageId: orphanedMsg.id },
  })

  // --- Invoke one reaper cycle synchronously --------------------------------
  await runReaperCycle()

  // --- Assert the message was marked "error" --------------------------------
  const afterMsg = await prisma.message.findUniqueOrThrow({
    where: { id: orphanedMsg.id },
  })
  assert.equal(afterMsg.status, "error", `Message status must be "error" after reap, got "${afterMsg.status}"`)
  assert.ok(
    typeof afterMsg.error === "string" && afterMsg.error.length > 0,
    "Message.error must be set after reap",
  )
  assert.ok(afterMsg.finishedAt !== null, "Message.finishedAt must be set after reap")

  // --- Assert activeMessageId was cleared -----------------------------------
  const afterSession = await prisma.appSession.findUniqueOrThrow({
    where: { id: session.id },
  })
  assert.equal(
    afterSession.activeMessageId,
    null,
    "AppSession.activeMessageId must be null after reap",
  )

  // --- Cleanup --------------------------------------------------------------
  await prisma.message.delete({ where: { id: orphanedMsg.id } })
  await prisma.appSession.delete({ where: { id: session.id } })
  await prisma.corpusVersion.deleteMany({ where: { projectId: project.id } })
  await prisma.project.update({ where: { id: project.id }, data: { headVersionId: null } })
  await prisma.project.delete({ where: { id: project.id } })

  console.log("  ✓ reaper marked orphaned message as error and cleared activeMessageId")
}

// ---------------------------------------------------------------------------
// Test 9: IngestService.submit no-op short-circuit (head == ingested)
//
// Creates a fresh project, manually sets ingestedVersionId = headVersionId so
// the delta is empty, then calls IngestService.submit and asserts that it
// returns a terminal done job with chunksWritten=0, stats.noOp=true, and that
// project.ingestedVersionId is set to the target version — all without hitting
// the cluster runner.
// ---------------------------------------------------------------------------
async function testIngestNoOpShortCircuit(owner: User): Promise<void> {
  console.log("\nTest 9: ingest no-op short-circuit")

  // Create a fresh project (gets an initial corpus_version at seq=1)
  const project = await ProjectService.create({
    name: `Smoke Ingest No-Op ${randomUUID()}`,
    ownerId: owner.id,
  })

  // Manually set ingestedVersionId = headVersionId so the delta is empty
  const headVersionId = project.headVersionId
  assert.ok(headVersionId !== null, "project must have a headVersionId after creation")

  await prisma.project.update({
    where: { id: project.id },
    data: { ingestedVersionId: headVersionId },
  })

  // Re-read so IngestService sees the updated ingestedVersionId
  const freshProject = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
  })

  // Submit — delta is empty (head == ingested) → no-op short-circuit
  const outcome = await IngestService.submit(freshProject, owner, {})
  assert.ok(
    outcome.kind === "job",
    `submit must return a job outcome (no paid OCR here), got "${outcome.kind}"`,
  )
  const job = outcome.job

  // Assertions
  assert.equal(job.status, INGEST_STATUS.DONE, `job.status must be "done", got "${job.status}"`)
  assert.equal(job.chunksWritten, 0, `chunksWritten must be 0, got ${job.chunksWritten}`)
  assert.ok(
    typeof job.stats === "object" &&
      job.stats !== null &&
      (job.stats as Record<string, unknown>)["noOp"] === true,
    `job.stats must contain noOp:true, got ${JSON.stringify(job.stats)}`,
  )
  assert.equal(
    job.targetVersionId,
    headVersionId,
    "job.targetVersionId must equal headVersionId",
  )

  // Verify project.ingestedVersionId was advanced to targetVersionId
  const afterProject = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
  })
  assert.equal(
    afterProject.ingestedVersionId,
    job.targetVersionId,
    "project.ingestedVersionId must equal job.targetVersionId after no-op",
  )

  // Cleanup
  await prisma.ingestJob.delete({ where: { id: job.id } })
  await prisma.corpusMembership.deleteMany({ where: { projectId: project.id } })
  await prisma.corpusVersion.deleteMany({ where: { projectId: project.id } })
  await prisma.project.update({
    where: { id: project.id },
    data: { headVersionId: null, ingestedVersionId: null },
  })
  await prisma.project.delete({ where: { id: project.id } })

  console.log("  \u2713 ingest no-op short-circuit")
}

// ---------------------------------------------------------------------------
// Test 10: Note citations parsed + persisted
//
// Calls NoteService.create with a body containing 2 [[ark|label|folio]]
// citations. Asserts:
//   - note.citationCount === 2
//   - exactly 2 Citation rows exist for the note
//   - each Citation has the correct ark + folio
// Cleans up after itself.
// ---------------------------------------------------------------------------
async function testNoteCitationsParsedAndPersisted(owner: User): Promise<void> {
  console.log("\nTest 10: note citations parsed + persisted")

  // Create an isolated project for this test.
  const project = await ProjectService.create({
    name: `Smoke Note Citations ${randomUUID()}`,
    ownerId: owner.id,
  })

  const ark1 = "ark:/12148/bpt6k5738219s"
  const ark2 = "ark:/12148/btv1b10500001g"

  const bodyMd = [
    "Le Figaro évoque l'inauguration [[ark:/12148/bpt6k5738219s|Le Figaro, 7 mai 1889|42]].",
    "La Gazette de France en rend compte également [[ark:/12148/btv1b10500001g|Gazette de France|17]].",
  ].join("\n")

  const note = await NoteService.create({
    projectId: project.id,
    title: "Test note — citations smoke",
    bodyMd,
  })

  assert.equal(
    note.citationCount,
    2,
    `note.citationCount must be 2, got ${note.citationCount}`,
  )

  const citations = await prisma.citation.findMany({
    where: { noteId: note.id },
    orderBy: { folio: "asc" },
  })

  assert.equal(
    citations.length,
    2,
    `Expected 2 Citation rows for noteId=${note.id}, got ${citations.length}`,
  )

  const [citeA, citeB] = citations as [typeof citations[0], typeof citations[0]]

  assert.equal(citeA.ark, ark2, `First citation (folio 17) must have ark=${ark2}`)
  assert.equal(citeA.folio, 17, `First citation must have folio=17, got ${citeA.folio}`)

  assert.equal(citeB.ark, ark1, `Second citation (folio 42) must have ark=${ark1}`)
  assert.equal(citeB.folio, 42, `Second citation must have folio=42, got ${citeB.folio}`)

  // --- note_append: add a paragraph with a 3rd citation, without resending body.
  const appended = await NoteService.append(note.id, {
    bodyMd:
      "## Suite\n\nUn troisième témoignage le confirme " +
      "[[ark:/12148/bpt6k9999999z|Le Temps, 8 mai 1889|3]].",
  })

  assert.equal(
    appended.citationCount,
    3,
    `After append, citationCount must be 3, got ${appended.citationCount}`,
  )
  assert.ok(
    appended.body_md.includes(bodyMd) && appended.body_md.includes("## Suite"),
    "Appended note must contain BOTH the original body and the new section",
  )
  assert.ok(
    appended.body_md.indexOf("## Suite") > appended.body_md.indexOf("Le Figaro"),
    "Appended section must come AFTER the original body",
  )

  // The prior body must be snapshotted to a NoteVersion (seq 0).
  const versions = await prisma.noteVersion.findMany({
    where: { noteId: note.id },
    orderBy: { seq: "asc" },
  })
  assert.equal(versions.length, 1, `Expected 1 NoteVersion after append, got ${versions.length}`)
  assert.equal(versions[0]!.body_md, bodyMd, "Snapshot must hold the pre-append body verbatim")

  const afterAppend = await prisma.citation.count({ where: { noteId: note.id } })
  assert.equal(afterAppend, 3, `Expected 3 Citation rows after append, got ${afterAppend}`)

  // An empty append is a no-op: no new version, body unchanged.
  const noop = await NoteService.append(note.id, { bodyMd: "   \n  " })
  assert.equal(noop.body_md, appended.body_md, "Empty append must not change the body")
  const versionsAfterNoop = await prisma.noteVersion.count({ where: { noteId: note.id } })
  assert.equal(versionsAfterNoop, 1, "Empty append must not create a NoteVersion")

  // Cleanup: Citations + NoteVersions cascade when Note is deleted via Prisma
  // but there are no cascade rules in the schema — delete explicitly.
  await prisma.citation.deleteMany({ where: { noteId: note.id } })
  await prisma.noteVersion.deleteMany({ where: { noteId: note.id } })
  await prisma.note.delete({ where: { id: note.id } })

  // Delete the project scaffolding.
  await prisma.corpusVersion.deleteMany({ where: { projectId: project.id } })
  await prisma.project.update({
    where: { id: project.id },
    data: { headVersionId: null, ingestedVersionId: null },
  })
  await prisma.project.delete({ where: { id: project.id } })

  console.log("  ✓ note citations parsed + persisted")
}

// ---------------------------------------------------------------------------
// Test 11: per-session corpus attribution + session facet/filter
//
// Two sessions add documents to one project:
//   - session A adds {shared, onlyA}
//   - session B adds {shared, onlyB}   ← `shared` is re-added from B
// Asserts:
//   1. `shared` carries TWO contribution rows (one per session); onlyA/onlyB one.
//   2. The snapshot session facet counts each session's contribution within the
//      filtered head set (A → 2, B → 2).
//   3. Filtering by session A narrows the corpus to {shared, onlyA} and excludes
//      onlyB; the multi-session `shared` appears under BOTH A and B filters.
// ---------------------------------------------------------------------------
async function testSessionAttributionFacet(owner: User): Promise<void> {
  console.log("\nTest 11: per-session attribution + session facet/filter")

  const project = await ProjectService.create({
    name: `Smoke Session Attribution ${randomUUID()}`,
    ownerId: owner.id,
  })

  // Two corpus sessions on the same project.
  const sessionA = await prisma.appSession.create({
    data: { projectId: project.id, scope: "corpus", title: "Mésopotamie" },
  })
  const sessionB = await prisma.appSession.create({
    data: { projectId: project.id, scope: "corpus", title: "Chine" },
  })

  const shared = `ark:/12148/smoketest-${randomUUID()}`
  const onlyA = `ark:/12148/smoketest-${randomUUID()}`
  const onlyB = `ark:/12148/smoketest-${randomUUID()}`

  // Session A adds {shared, onlyA}; session B adds {shared, onlyB}. addArks
  // stubs unknown ARKs itself, so no pre-seeding is needed.
  await CorpusService.addArks(
    project,
    owner,
    { arks: [shared, onlyA], reason: "smoke-session-A" },
    sessionA.id,
  )
  await CorpusService.addArks(
    project,
    owner,
    { arks: [shared, onlyB], reason: "smoke-session-B" },
    sessionB.id,
  )

  // --- 1. Contribution rows: shared has two, the singletons have one ----------
  const sharedContribs = await prisma.corpusContribution.findMany({
    where: { projectId: project.id, ark: shared },
  })
  assert.equal(
    sharedContribs.length,
    2,
    `Shared ARK must carry two contribution rows (multi-session), got ${sharedContribs.length}`,
  )
  const onlyAContribs = await prisma.corpusContribution.count({
    where: { projectId: project.id, ark: onlyA },
  })
  const onlyBContribs = await prisma.corpusContribution.count({
    where: { projectId: project.id, ark: onlyB },
  })
  assert.equal(onlyAContribs, 1, "onlyA must carry exactly one contribution row")
  assert.equal(onlyBContribs, 1, "onlyB must carry exactly one contribution row")

  // Re-adding `shared` from session A again must NOT create a duplicate row
  // (composite PK + skipDuplicates).
  await CorpusService.addArks(
    project,
    owner,
    { arks: [shared], reason: "smoke-session-A-readd" },
    sessionA.id,
  )
  const sharedContribsAfter = await prisma.corpusContribution.count({
    where: { projectId: project.id, ark: shared },
  })
  assert.equal(
    sharedContribsAfter,
    2,
    `Same-session re-add must not duplicate the contribution row, got ${sharedContribsAfter}`,
  )

  // --- 2. Session facet counts (unfiltered head) -----------------------------
  const full = await CorpusQueries.snapshot(project.id, "head")
  const facetById = new Map(full.sessions.map((s) => [s.sessionId, s.count]))
  assert.equal(
    facetById.get(sessionA.id),
    2,
    `Session A facet count must be 2, got ${facetById.get(sessionA.id)}`,
  )
  assert.equal(
    facetById.get(sessionB.id),
    2,
    `Session B facet count must be 2, got ${facetById.get(sessionB.id)}`,
  )
  // Titles are resolved onto the facet.
  const titleA = full.sessions.find((s) => s.sessionId === sessionA.id)?.title
  assert.equal(titleA, "Mésopotamie", "Session facet must carry the session title")

  // --- 3. Filtering by session A narrows the corpus --------------------------
  const filteredA = await CorpusQueries.snapshot(project.id, "head", {
    filters: { session: [sessionA.id] },
    limit: 100,
  })
  const arksA = new Set(filteredA.sample.map((d) => d.ark))
  assert.equal(filteredA.total, 2, `Session A filter must yield 2 docs, got ${filteredA.total}`)
  assert.ok(arksA.has(shared), "Session A filter must include the shared (multi-session) doc")
  assert.ok(arksA.has(onlyA), "Session A filter must include onlyA")
  assert.ok(!arksA.has(onlyB), "Session A filter must exclude onlyB")

  // The shared doc appears under session B too (multi-session attribution).
  const filteredB = await CorpusQueries.snapshot(project.id, "head", {
    filters: { session: [sessionB.id] },
    limit: 100,
  })
  const arksB = new Set(filteredB.sample.map((d) => d.ark))
  assert.equal(filteredB.total, 2, `Session B filter must yield 2 docs, got ${filteredB.total}`)
  assert.ok(arksB.has(shared), "Shared doc must appear under session B too")
  assert.ok(arksB.has(onlyB), "Session B filter must include onlyB")
  assert.ok(!arksB.has(onlyA), "Session B filter must exclude onlyA")

  // --- Cleanup ---------------------------------------------------------------
  await deleteProject(project.id)

  console.log("  ✓ per-session attribution + session facet/filter")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════")
  console.log("BnF Corpus Research — Smoke Test")
  console.log("═══════════════════════════════════════════════")

  const results = {
    advisoryLock: false,
    noOpDelta: false,
    betterAuth: false,
    parseBnfDate: false,
    docTypeMapping: false,
    sourceFromArk: false,
    normalizeManyRejection: false,
    reaperOrphanRecovery: false,
    ingestNoOpShortCircuit: false,
    noteCitationsPersisted: false,
    sessionAttributionFacet: false,
  }

  // --- Setup: one real owner user for Tests 1 + 2 --------------------------
  console.log("\nSetup: ensuring smoke owner user …")
  try {
    smokeUser = await setupSmokeUser()
  } catch (err: unknown) {
    console.error("FATAL setup failed:", err)
    process.exit(1)
  }

  // --- Run tests -----------------------------------------------------------
  try {
    await testAdvisoryLockMonotonicSeq(smokeUser)
    results.advisoryLock = true
  } catch (err: unknown) {
    console.error("FAIL Test 1 (advisory lock):", err)
  }

  try {
    await testNoOpDeltaShortCircuit(smokeUser)
    results.noOpDelta = true
  } catch (err: unknown) {
    console.error("FAIL Test 2 (no-op delta):", err)
  }

  try {
    await testBetterAuthRoundTrip()
    results.betterAuth = true
  } catch (err: unknown) {
    console.error("FAIL Test 3 (better-auth):", err)
  }

  // --- Pure normalize-layer tests (no network, no Prisma) ------------------
  try {
    testParseBnfDateFixtures()
    results.parseBnfDate = true
  } catch (err: unknown) {
    console.error("FAIL Test 4 (parseBnfDate fixtures):", err)
  }

  try {
    testDocTypeMappingFixtures()
    results.docTypeMapping = true
  } catch (err: unknown) {
    console.error("FAIL Test 5 (docType mapping fixtures):", err)
  }

  try {
    testSourceFromArkFixtures()
    results.sourceFromArk = true
  } catch (err: unknown) {
    console.error("FAIL Test 6 (sourceFromArk fixtures):", err)
  }

  try {
    testNormalizeManyRejection()
    results.normalizeManyRejection = true
  } catch (err: unknown) {
    console.error("FAIL Test 7 (normalizeMany rejection):", err)
  }

  try {
    await testReaperOrphanRecovery(smokeUser)
    results.reaperOrphanRecovery = true
  } catch (err: unknown) {
    console.error("FAIL Test 8 (reaper orphan recovery):", err)
  }

  try {
    await testIngestNoOpShortCircuit(smokeUser)
    results.ingestNoOpShortCircuit = true
  } catch (err: unknown) {
    console.error("FAIL Test 9 (ingest no-op short-circuit):", err)
  }

  try {
    await testNoteCitationsParsedAndPersisted(smokeUser)
    results.noteCitationsPersisted = true
  } catch (err: unknown) {
    console.error("FAIL Test 10 (note citations parsed + persisted):", err)
  }

  try {
    await testSessionAttributionFacet(smokeUser)
    results.sessionAttributionFacet = true
  } catch (err: unknown) {
    console.error("FAIL Test 11 (per-session attribution + session facet/filter):", err)
  }

  // --- Cleanup (always) ----------------------------------------------------
  console.log("\nCleaning up …")
  try {
    await cleanup()
    console.log("  ✓ cleanup done")
  } catch (err: unknown) {
    console.error("  ⚠ cleanup error (non-fatal):", err)
  }

  // --- Summary -------------------------------------------------------------
  console.log("\n═══════════════════════════════════════════════")
  console.log("Summary")
  console.log("═══════════════════════════════════════════════")
  const tick = (v: boolean) => (v ? "✓" : "✗")
  console.log(`  ${tick(results.advisoryLock)} advisory lock + monotonic seq`)
  console.log(`  ${tick(results.noOpDelta)} no-op delta short-circuit`)
  console.log(`  ${tick(results.betterAuth)} better-auth round-trip`)
  console.log(`  ${tick(results.parseBnfDate)} parseBnfDate fixtures`)
  console.log(`  ${tick(results.docTypeMapping)} mapCatalogueDocType + normalizeDocument mapping fixtures`)
  console.log(`  ${tick(results.sourceFromArk)} sourceFromArk fixtures`)
  console.log(`  ${tick(results.normalizeManyRejection)} normalizeMany rejection`)
  console.log(`  ${tick(results.reaperOrphanRecovery)} reaper orphan recovery`)
  console.log(`  ${tick(results.ingestNoOpShortCircuit)} ingest no-op short-circuit`)
  console.log(`  ${tick(results.noteCitationsPersisted)} note citations parsed + persisted`)
  console.log(`  ${tick(results.sessionAttributionFacet)} per-session attribution + session facet/filter`)
  console.log("═══════════════════════════════════════════════")

  process.exit(Object.values(results).every(Boolean) ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error("Unexpected top-level error:", err)
  process.exit(1)
})
