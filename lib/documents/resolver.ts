// lib/documents/resolver.ts
// Background metadata resolver — the Document table IS the work queue.
//
// `corpus_add` inserts "stub" Document rows (resolveStatus="pending") and
// returns instantly; this drainer resolves their BnF metadata out-of-band so
// curation is never coupled to MCP availability/latency. A transient MCP
// failure increments resolveAttempts and leaves the row pending (retried on the
// next kick / boot resume) until RESOLVE_MAX_ATTEMPTS, after which it is marked
// "failed".
//
// Execution: kicked via `after()` at add time and resumed at boot from
// instrumentation.ts. There is no separate job table and no external worker —
// the cluster runner does ingestion, not MCP resolution (MCP is app-side).
import "server-only"

import { after } from "next/server"

import {
  RESOLVE_BATCH_SIZE,
  RESOLVE_DRAIN_MAX_BATCHES,
  RESOLVE_MAX_ATTEMPTS,
} from "@/lib/constants"
import { prisma } from "@/lib/db"
import { BnfDirectClient } from "@/lib/bnf/direct"
import { normalizeMany } from "@/lib/mcp/normalize"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"

/** Structured log line for the resolver. Prefix lets ops grep `[resolver]`. */
function log(msg: string): void {
  console.log(`[resolver] ${msg}`)
}

// ---------------------------------------------------------------------------
// Per-project re-entrancy guard
// ---------------------------------------------------------------------------
// At most one drain runs per project at a time. A drain requested while one is
// active sets `rerun` so the active loop picks up rows added in the meantime,
// rather than being silently dropped.
const active = new Map<string, { rerun: boolean }>()

type PrismaJsonValue =
  Parameters<typeof prisma.document.create>[0]["data"]["rawMetadata"]

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Resolve all currently-pending Document rows for a project. Re-entrant-safe:
 * concurrent calls coalesce into a single active drain that re-checks for new
 * pending rows before exiting.
 */
export async function resolvePendingForProject(
  projectId: string,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const existing = active.get(projectId)
  if (existing) {
    existing.rerun = true
    return
  }
  const state = { rerun: false }
  active.set(projectId, state)
  try {
    do {
      state.rerun = false
      await drainOnce(projectId, opts?.signal)
    } while (state.rerun && !opts?.signal?.aborted)
  } finally {
    active.delete(projectId)
  }
}

/**
 * One drain pass: snapshot the pending ARKs (bounded), resolve them in batches,
 * and write each row to resolved/failed. Each ARK is attempted at most once per
 * pass — failures stay pending (below the ceiling) and are retried on the next
 * kick, which gives natural spacing without an in-loop sleep.
 */
async function drainOnce(projectId: string, signal?: AbortSignal): Promise<void> {
  const pending = await prisma.document.findMany({
    where: {
      projectId,
      resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
      resolveAttempts: { lt: RESOLVE_MAX_ATTEMPTS },
    },
    select: { ark: true, resolveAttempts: true },
    orderBy: { resolveAttempts: "asc" }, // give freshest stubs priority
    take: RESOLVE_BATCH_SIZE * RESOLVE_DRAIN_MAX_BATCHES,
  })
  if (pending.length === 0) return

  log(`project ${projectId}: draining ${pending.length} pending document(s) (direct BnF)`)
  const attemptsByArk = new Map(pending.map((p) => [p.ark, p.resolveAttempts]))
  const client = new BnfDirectClient({ signal })
  let resolvedCount = 0
  let failedCount = 0
  let stillPendingCount = 0

  for (const batch of chunk(pending.map((p) => p.ark), RESOLVE_BATCH_SIZE)) {
    if (signal?.aborted) {
      log(`project ${projectId}: aborted mid-drain`)
      return
    }

    const results = await client.resolveArks(batch)
    const okDocs = results.filter((r) => r.ok).map((r) => r.document)
    const normalised = normalizeMany(okDocs)
    const normalisedByArk = new Map(normalised.map((n) => [n.ark, n]))

    for (const r of results) {
      const doc = normalisedByArk.get(r.ark)
      if (r.ok && doc) {
        resolvedCount++
        await prisma.document.update({
          where: { projectId_ark: { projectId, ark: r.ark } },
          data: {
            title: doc.title,
            author: doc.author ?? null,
            year: doc.year ?? null,
            dateLabel: doc.dateLabel ?? null,
            docType: doc.docType,
            lang: doc.lang ?? null,
            source: doc.source,
            pages: doc.pages ?? null,
            excerpt: doc.excerpt ?? null,
            iiifManifestUrl: doc.iiifManifestUrl ?? null,
            ocrAvailable: doc.ocrAvailable ?? null,
            rawMetadata: doc.rawMetadata as PrismaJsonValue,
            resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
            resolveError: null,
            resolvedAt: new Date(),
          },
        })
      } else {
        // Either the resolve call failed, or it succeeded but normalize dropped
        // the record (no title / unusable). Both count as a failed attempt.
        const reason = r.ok
          ? "métadonnées incomplètes (titre ou identifiant manquant)"
          : describeError(r.error)
        const nextAttempts = (attemptsByArk.get(r.ark) ?? 0) + 1
        const giveUp = nextAttempts >= RESOLVE_MAX_ATTEMPTS
        if (giveUp) failedCount++
        else stillPendingCount++
        log(
          `  ${giveUp ? "FAILED" : "retry"} ${r.ark} (attempt ${nextAttempts}/${RESOLVE_MAX_ATTEMPTS}): ${reason}`,
        )
        await prisma.document.update({
          where: { projectId_ark: { projectId, ark: r.ark } },
          data: {
            resolveAttempts: nextAttempts,
            resolveError: reason,
            ...(giveUp ? { resolveStatus: DOCUMENT_RESOLVE_STATUS.FAILED } : {}),
          },
        })
      }
    }
  }

  log(
    `project ${projectId}: drain done — resolved=${resolvedCount}, failed=${failedCount}, still-pending=${stillPendingCount}`,
  )
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Schedule a drain to run after the current response is flushed. Must be called
 * from within a request scope (agent tool handler / route). The request signal
 * is deliberately NOT threaded in — the drain outlives the request; its MCP
 * calls are individually bounded by BNF_MCP_TIMEOUT_MS.
 */
export function kickResolve(projectId: string): void {
  after(async () => {
    await resolvePendingForProject(projectId).catch((err: unknown) => {
      console.error(`[resolver] drain failed for project ${projectId}:`, err)
    })
  })
}

/**
 * Boot-time resume: drain every project that still has pending stubs (e.g. left
 * over from a process restart mid-resolution). Fire-and-forget from
 * instrumentation.ts — never blocks startup.
 */
export async function resumePendingResolves(): Promise<void> {
  const projects = await prisma.document.findMany({
    where: {
      resolveStatus: DOCUMENT_RESOLVE_STATUS.PENDING,
      resolveAttempts: { lt: RESOLVE_MAX_ATTEMPTS },
    },
    distinct: ["projectId"],
    select: { projectId: true },
  })
  if (projects.length === 0) return

  console.warn(
    `[resolver] boot resume — draining ${projects.length} project(s) with pending documents`,
  )
  for (const { projectId } of projects) {
    await resolvePendingForProject(projectId).catch((err: unknown) => {
      console.error(`[resolver] boot drain failed for project ${projectId}:`, err)
    })
  }
}
