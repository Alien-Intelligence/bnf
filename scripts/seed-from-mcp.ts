/**
 * scripts/seed-from-mcp.ts — Real-data seed via the BnF MCP.
 *
 * Run via: npm run seed:from-mcp
 * Which executes: tsx --conditions react-server scripts/seed-from-mcp.ts
 *
 * Required environment variables (via .env.local, auto-loaded by tsx):
 *   DATABASE_URL       — Postgres connection string
 *   BETTER_AUTH_SECRET — ≥ 32-char secret for better-auth token signing
 *   BETTER_AUTH_URL    — e.g. http://localhost:3000
 *   BNF_MCP_URL        — MCP base URL, e.g. https://bnf.mcp.alien.club/mcp
 *   BNF_MCP_TOKEN      — long-lived service Bearer token (ask the team)
 *
 * ANTHROPIC_API_KEY is NOT required — no agent is involved.
 *
 * Idempotent: re-running exits early if the project already has documents.
 * The slice-1 fake seed (npx prisma db seed) is untouched by this script.
 *
 * Exit codes:
 *   0 — success (or early-exit because already seeded)
 *   1 — fatal error (missing env, all ARKs failed, etc.)
 */

// NOTE: tsx --conditions react-server makes `server-only` resolve to the empty
// shim so we can import service modules that guard against client bundling.
// .env.local is loaded by tsx via --env-file-if-exists before ESM imports run.

import { auth } from "@/lib/auth"
import { requireMcpEnv } from "@/lib/env"
import { BnfMcpClient } from "@/lib/mcp/bnf-client"
import { normalizeMany } from "@/lib/mcp/normalize"
import { CorpusService } from "@/models/corpus/service"
import { DocumentService } from "@/models/documents/service"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectService } from "@/models/projects/service"
import { UserQueries } from "@/models/users/queries"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_USER_EMAIL = "leo@alien.club"
const DEV_USER_PASSWORD = "dev-local"
const DEV_USER_NAME = "Leo"

const PROJECT_NAME = "Exposition Universelle 1889 (réel)"
const PROJECT_SUBTITLE = "Corpus · presse 1889 · données réelles BnF"

/** Maximum results to request from the MCP (MCP cap is 50). */
const SEARCH_MAXIMUM_RECORDS = 50

/** Maximum hits to resolve — stays within the 50-hit cap. */
const RESOLVE_LIMIT = 30

// ---------------------------------------------------------------------------
// Helper: narrow isEmailAlreadyExistsError
// (mirrors prisma/seed.ts to stay consistent — same auth library, same error shape)
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

  if (e["status"] === "UNPROCESSABLE_ENTITY") {
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seedFromMcp(): Promise<void> {
  console.log("=== BnF seed:from-mcp: starting ===")

  // ── Step 1: Validate MCP env ──────────────────────────────────────────────
  // requireMcpEnv() throws with a clear message listing the missing keys.
  // Let it propagate — no recovery is possible without the token.
  console.log("Step 1: validating MCP environment …")
  requireMcpEnv()
  console.log("  ✓ BNF_MCP_URL + BNF_MCP_TOKEN present")

  // ── Step 2: Ensure dev user ───────────────────────────────────────────────
  console.log(`Step 2: ensuring dev user ${DEV_USER_EMAIL} …`)

  try {
    await auth.api.signUpEmail({
      body: {
        email: DEV_USER_EMAIL,
        password: DEV_USER_PASSWORD,
        name: DEV_USER_NAME,
      },
    })
    console.log("  ✓ Dev user created")
  } catch (err: unknown) {
    if (isEmailAlreadyExistsError(err)) {
      console.log("  ✓ Dev user already exists — skipping creation")
    } else {
      throw err
    }
  }

  const devUser = await UserQueries.getByEmail(DEV_USER_EMAIL)
  if (!devUser) {
    throw new Error(
      `Dev user ${DEV_USER_EMAIL} not found after creation — database inconsistency`,
    )
  }
  console.log(`  userId = ${devUser.id}`)

  // ── Step 3: Ensure project ────────────────────────────────────────────────
  console.log(`Step 3: ensuring project "${PROJECT_NAME}" …`)

  const existingProjects = await ProjectQueries.listForOwner(devUser.id)
  let project = existingProjects.find((p) => p.name === PROJECT_NAME) ?? null

  if (!project) {
    project = await ProjectService.create({
      name: PROJECT_NAME,
      subtitle: PROJECT_SUBTITLE,
      ownerId: devUser.id,
    })
    console.log(`  ✓ Project created (id=${project.id})`)
  } else {
    console.log(`  ✓ Project already exists (id=${project.id})`)
  }

  // ── Step 4: Idempotency check ─────────────────────────────────────────────
  // If the project already has documents, another seed run already succeeded.
  // Exit cleanly rather than re-adding duplicates.
  console.log("Step 4: checking for existing documents …")

  const { prisma } = await import("@/lib/db")
  const existingDocCount = await prisma.document.count({
    where: { projectId: project.id },
  })

  if (existingDocCount > 0) {
    console.log(
      `  ✓ Project already has ${existingDocCount} document(s) — nothing to do.`,
    )
    console.log("")
    console.log("=== BnF seed:from-mcp: already seeded (exit 0) ===")
    console.log(
      `  URL: http://localhost:3000/projects/${project.id}/constituer`,
    )
    return
  }

  console.log("  No documents yet — proceeding with MCP fetch.")

  // ── Step 5: Search Gallica ────────────────────────────────────────────────
  console.log("Step 5: searching Gallica for Exposition Universelle 1889 presse …")

  const client = new BnfMcpClient()
  const searchResult = await client.searchGallica({
    query: "Exposition Universelle 1889 presse",
    doc_type: "fascicule",
    date: "1889",
    maximum_records: SEARCH_MAXIMUM_RECORDS,
  })

  const hits = searchResult.hits.slice(0, RESOLVE_LIMIT)
  console.log(
    `  ✓ Got ${searchResult.total} total hit(s) — resolving first ${hits.length}`,
  )

  if (hits.length === 0) {
    throw new Error(
      "MCP returned no search hits — check BNF_MCP_TOKEN and BNF_MCP_URL.",
    )
  }

  // ── Step 6: Resolve ARKs (partial-failure tolerant) ──────────────────────
  console.log(`Step 6: resolving ${hits.length} ARKs …`)

  const arks = hits.map((h) => h.ark)
  const resolveResults = await client.resolveArks(arks)

  const okResults = resolveResults.filter((r) => r.ok === true)
  const failedResults = resolveResults.filter((r) => r.ok === false)

  for (const failed of failedResults) {
    process.stderr.write(
      `  [warn] ARK resolve failed: ${failed.ark} — ${String((failed as { ok: false; error: unknown }).error)}\n`,
    )
  }

  console.log(
    `  ✓ Resolved ${okResults.length} ok, ${failedResults.length} failed`,
  )

  if (okResults.length === 0) {
    throw new Error(
      "MCP returned no usable documents — check BNF_MCP_TOKEN and URL.",
    )
  }

  // ── Step 7: Normalize ─────────────────────────────────────────────────────
  console.log("Step 7: normalizing resolved documents …")

  const rawDocuments = okResults
    .filter((r): r is typeof r & { ok: true } => r.ok === true)
    .map((r) => r.document)

  const normalised = normalizeMany(rawDocuments, {
    unknownDocTypeHook: (raw, source) => {
      console.warn(`  [warn] unknown docType '${raw}' from ${source}`)
    },
  })

  console.log(
    `  ✓ Normalised ${normalised.length} document(s) (dropped ${rawDocuments.length - normalised.length} incomplete records)`,
  )

  if (normalised.length === 0) {
    throw new Error(
      "Normalisation produced zero documents — all resolved records were incomplete. " +
        "Check BNF_MCP_TOKEN, BNF_MCP_URL, and the normalize.ts mapping tables.",
    )
  }

  // ── Step 8: Upsert Document rows ──────────────────────────────────────────
  console.log(`Step 8: upserting ${normalised.length} Document rows …`)

  // NormalizedDocument.rawMetadata is typed as `unknown` while
  // DocumentUpsertData (via Prisma.DocumentCreateInput) expects InputJsonValue.
  // The actual value at runtime is always a plain object from JSON.parse, which
  // satisfies Prisma's runtime expectations. We narrow with an explicit cast
  // confined to this adapter rather than broadening either type's declaration.
  type PrismaJsonValue = Parameters<typeof prisma.document.create>[0]["data"]["rawMetadata"]

  const docsToUpsert = normalised.map((n) => ({
    ...n,
    rawMetadata: n.rawMetadata as PrismaJsonValue,
  }))

  await DocumentService.upsertMany(project.id, docsToUpsert)
  console.log(`  ✓ ${normalised.length} document row(s) upserted`)

  // ── Step 9: Add ARKs to corpus ────────────────────────────────────────────
  console.log("Step 9: adding ARKs to corpus via CorpusService.addArks …")

  const addResult = await CorpusService.addArks(project, devUser, {
    arks: normalised.map((n) => n.ark),
    reason: "seed-from-mcp",
  })

  console.log(
    `  ✓ addArks complete — head seq=${addResult.versionSeq}, total=${addResult.total}, +${addResult.lastDeltaAdded}`,
  )

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("")
  console.log("=== BnF seed:from-mcp: complete ===")
  console.log("")
  console.log(`Dev user:   ${DEV_USER_EMAIL}  /  password: ${DEV_USER_PASSWORD}`)
  console.log("")
  console.log(`Project:    "${PROJECT_NAME}" (id=${project.id})`)
  console.log(`  URL:      http://localhost:3000/projects/${project.id}/constituer`)
  console.log(`  Head:     seq=${addResult.versionSeq}`)
  console.log("")
  console.log("Counts:")
  console.log(`  Search hits returned:    ${searchResult.total} (capped at ${hits.length})`)
  console.log(`  ARKs resolved ok:        ${okResults.length}`)
  console.log(`  ARKs failed at resolve:  ${failedResults.length}`)
  console.log(`  Documents normalised:    ${normalised.length}`)
  console.log(`  Document rows inserted:  ${normalised.length}`)
  console.log(`  Head corpus seq:         ${addResult.versionSeq}`)
}

seedFromMcp()
  .then(() => {
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("seed:from-mcp failed:", err)
    process.exit(1)
  })
