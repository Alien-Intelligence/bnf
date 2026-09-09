// lib/agent/tools/ingestion-guard.ts
// Shared "is the corpus ingested yet?" guard for agent tools that only make
// sense over the INGESTED corpus (RAG search, note writing). Extracted from
// rag.ts so note.ts can enforce the same structural check — a research session
// can exist before any ingestion, and a note written from general knowledge
// before retrieval is the "mis-informed notes" bug (design: item 4).
//
// Returns a structured error (not a throw) so the agent can explain the
// situation to the librarian and recover within the turn — a tool call never
// throws out of the loop (CLAUDE_ERROR_PATTERNS.md §15).
import "server-only"

import { prisma } from "@/lib/db"

/** Error shown when a search is attempted before any ingestion is committed. */
export const NOT_INGESTED_ERROR =
  "Le corpus n'a pas encore été ingéré. " +
  "Lance l'ingestion depuis l'étape « Ingérer » avant de lancer une recherche."

/** Error shown when a note is attempted before any ingestion is committed. A
 *  note must rest on retrieved passages, never on general knowledge. */
export const NOTE_NOT_INGESTED_ERROR =
  "Aucune ingestion n'a encore été faite pour ce projet. Les notes doivent " +
  "s'appuyer sur le corpus ingéré (via rag_query) — lance d'abord l'ingestion " +
  "depuis l'étape « Ingérer », puis interroge le corpus avant de rédiger une note."

/**
 * Error shown when a derived workspace's corpus grant has been revoked. Distinct
 * from NOT_INGESTED_ERROR on purpose: "nobody has ingested this yet" invites the
 * librarian to run an ingestion; "your access was revoked" is not theirs to fix,
 * and the agent must say so rather than proposing a step that would fail.
 */
export const CORPUS_ACCESS_REVOKED_ERROR =
  "L'accès au corpus partagé a été révoqué. Les notes déjà rédigées restent " +
  "disponibles, mais le corpus n'est plus interrogeable. Contacte le " +
  "propriétaire du corpus pour rétablir le partage."

/** The corpus fields a tool handler needs off its turn context. */
export type CorpusScopedCtx = {
  /** The project whose corpus this turn reads — the source, when derived. */
  corpusProjectId: string
  /** False when this is a derived project whose grant was revoked. */
  corpusReachable: boolean
}

/**
 * Resolve the ingested version of the corpus this turn reads, or the reason it
 * cannot be used. One call covers both failure modes so a handler cannot check
 * ingestion and forget revocation.
 */
export async function resolveIngestedCorpus(
  ctx: CorpusScopedCtx,
  notIngestedError: string,
): Promise<{ versionId: string } | { error: string }> {
  if (!ctx.corpusReachable) return { error: CORPUS_ACCESS_REVOKED_ERROR }

  const versionId = await ingestedVersionId(ctx.corpusProjectId)
  if (!versionId) return { error: notIngestedError }

  return { versionId }
}

/** Resolve the project's committed ingested version id, or null if none. */
export async function ingestedVersionId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { ingestedVersionId: true },
  })
  return project.ingestedVersionId
}
