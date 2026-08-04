// lib/agent/tools/ingestion-guard.ts
// Shared "is the corpus ingested yet?" guard for agent tools that only make
// sense over the INGESTED corpus (RAG search, note writing). Extracted from
// rag.ts so note.ts can enforce the same structural check — a research session
// can exist before any ingestion, and a note written from general knowledge
// before retrieval is the "mis-informed notes" bug (design: item 4).
//
// Returns a structured error (not a throw) so the agent can explain the
// situation to the librarian and recover within the turn.
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

/** Resolve the project's committed ingested version id, or null if none. */
export async function ingestedVersionId(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { ingestedVersionId: true },
  })
  return project.ingestedVersionId
}
