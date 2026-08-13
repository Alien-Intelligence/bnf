/**
 * scripts/validate-ingest-hardening.ts — live validation harness for the
 * ingest-hardening pass (ai-memories/tech/repos/bnf/ingest-hardening).
 *
 * Run via:  npx tsx --env-file-if-exists=.env.local --conditions react-server \
 *             scripts/validate-ingest-hardening.ts <arkCount> [--label gate1]
 *
 * Preconditions: local stack up in CLUSTER_MODE=real (run-local skill), the
 * worker's BnF egress routed through a GREENLIGHTED broker (the dev machine's
 * own IP 401s at BnF — see docker-compose.override.yml / platform-dev proxy).
 *
 * What it does (all through the real app services — no shortcuts):
 *   1. Ensures an idempotent validation user + a FRESH project per invocation
 *      (fresh project = fresh delta; re-running never no-ops).
 *   2. CorpusService.addArks with N real, known-text-lane BnF ARKs.
 *   3. IngestService.submit → the real worker over HTTP.
 *   4. Polls the job row + the worker read-model until terminal (bounded),
 *      printing one status line per poll so a wedge is visible immediately.
 *   5. Prints the final verdict: per-doc outcomes, failure/warning summary,
 *      and exits 0 iff the job reached a terminal state with ≤ maxFailed
 *      failures (default 0).
 *
 * The SELF-HEAL gate is driven from outside: start a run, `docker kill`
 * the worker mid-run, `docker compose --profile worker up -d ingest-worker`,
 * and this script's poll loop should still reach a terminal state — the
 * reconciler re-drives whatever the kill orphaned. No flag needed here.
 */
import assert from "node:assert/strict"

import { prisma } from "@/lib/db"
import { ProjectService } from "@/models/projects/service"
import { CorpusService } from "@/models/corpus/service"
import { IngestService } from "@/models/ingest/service"
import { INGEST_STATUS } from "@/models/ingest/schema"
import type { User } from "@/lib/generated/prisma/client"

// Real BnF ARKs, all resolved + ingested as TEXT lane in the 2026-08-11 prod
// run — no paid OCR, no vision spend; the cheapest honest end-to-end load.
const TEXT_ARKS = [
  "ark:/12148/bpt6k2772862g",
  "ark:/12148/bpt6k47481094",
  "ark:/12148/bpt6k47481168",
  "ark:/12148/bpt6k41213495",
  "ark:/12148/bd6t5721543",
  "ark:/12148/bpt6k2772946q",
  "ark:/12148/bpt6k4748088d",
  "ark:/12148/bpt6k2772876h",
  "ark:/12148/bpt6k4748188r",
  "ark:/12148/bpt6k2772958x",
  "ark:/12148/bd6t5721334",
  "ark:/12148/bd6t569377s",
]

const VALIDATION_EMAIL = "ingest-hardening-validation@alien.club"
/** Wall-clock ceiling on the whole watch loop (§14 — never poll unbounded). */
const WATCH_CEILING_MS = 30 * 60 * 1000
const POLL_MS = 10 * 1000

function ts(): string {
  return new Date().toISOString().slice(11, 19)
}

async function ensureUser(): Promise<User> {
  const existing = await prisma.user.findFirst({ where: { email: VALIDATION_EMAIL } })
  if (existing) return existing
  return prisma.user.create({
    data: {
      id: crypto.randomUUID(),
      email: VALIDATION_EMAIL,
      name: "Ingest Hardening Validation",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  })
}

async function main(): Promise<void> {
  const labelIdx = process.argv.indexOf("--label")
  const label = labelIdx > 0 ? process.argv[labelIdx + 1] : "gate"
  const fileIdx = process.argv.indexOf("--arks-file")
  let arks: string[]
  if (fileIdx > 0) {
    const { readFileSync } = await import("node:fs")
    arks = readFileSync(process.argv[fileIdx + 1]!, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("ark:/"))
    assert(arks.length >= 1, "arks file is empty")
  } else {
    const count = Number(process.argv[2])
    assert(
      Number.isInteger(count) && count >= 1 && count <= TEXT_ARKS.length,
      `usage: validate-ingest-hardening.ts <1..${TEXT_ARKS.length}> [--label x] | --arks-file <path>`,
    )
    arks = TEXT_ARKS.slice(0, count)
  }
  const count = arks.length

  assert.equal(process.env.CLUSTER_MODE, "real", "CLUSTER_MODE must be 'real'")

  const user = await ensureUser()
  const project = await ProjectService.create({
    name: `[validation] ingest-hardening ${label} ${new Date().toISOString()}`,
    subtitle: `${count} text-lane ARKs`,
    ownerId: user.id,
  })
  console.log(`[${ts()}] project ${project.id} (${count} arks)`)

  const add = await CorpusService.addArks(
    project,
    user,
    { arks, reason: `validation ${label}` },
    undefined,
    { canonicalize: false },
  )
  console.log(
    `[${ts()}] corpus add: +${add.lastDeltaAdded} (pending=${add.pending}, nonIngestable=${add.nonIngestable.length})`,
  )

  // Re-read the project (addArks advanced headVersionId).
  const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } })
  const outcome = await IngestService.submit(fresh, user, {})
  assert(outcome.kind === "job", `submit outcome: ${outcome.kind}`)
  let job = outcome.job
  console.log(
    `[${ts()}] job ${job.id} status=${job.status} clusterJobId=${job.clusterJobId ?? "-"} added=${job.addedCount} excluded=${job.excludedCount ?? 0}`,
  )

  const deadline = Date.now() + WATCH_CEILING_MS
  const terminal = new Set<string>([
    INGEST_STATUS.DONE,
    INGEST_STATUS.PARTIAL,
    INGEST_STATUS.FAILED,
    INGEST_STATUS.CANCELED,
  ])
  while (!terminal.has(job.status)) {
    if (Date.now() > deadline) {
      console.error(`[${ts()}] WATCH CEILING (${WATCH_CEILING_MS}ms) — job still ${job.status}`)
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
    job = await prisma.ingestJob.findUniqueOrThrow({ where: { id: job.id } })
    const live = await IngestService.queueProgress(job).catch(() => null)
    const docs = live?.docs
    console.log(
      `[${ts()}] status=${job.status}` +
        (docs
          ? ` docs done=${docs.done} failed=${docs.failed} skipped=${docs.skipped} queued=${docs.queued} planned=${docs.planned} ready=${docs.ready}`
          : " (no live read-model)"),
    )
  }

  const stats = (job.stats ?? {}) as Record<string, unknown>
  const errors = Array.isArray(stats.errors)
    ? (stats.errors as Array<{ ark: string; reason: string; warning?: boolean }>)
    : []
  const failures = errors.filter((e) => !e.warning)
  const warnings = errors.filter((e) => e.warning)
  console.log(`\n[${ts()}] TERMINAL: ${job.status}  chunksWritten=${job.chunksWritten ?? 0}`)
  console.log(`  stats: ${JSON.stringify({ ...stats, errors: undefined })}`)
  for (const f of failures) console.log(`  FAIL  ${f.ark}: ${f.reason}`)
  for (const w of warnings) console.log(`  WARN  ${w.ark}: ${w.reason}`)

  const indexed = await prisma.document.count({
    where: { projectId: project.id, indexedAt: { not: null } },
  })
  console.log(`  indexedAt set on ${indexed}/${count} docs`)

  const ok =
    (job.status === INGEST_STATUS.DONE || job.status === INGEST_STATUS.PARTIAL) &&
    failures.length === 0 &&
    indexed === count
  console.log(ok ? "\nVALIDATION PASS" : "\nVALIDATION FAIL")
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error("[validate] fatal:", err instanceof Error ? err.stack : err)
  process.exit(1)
})
