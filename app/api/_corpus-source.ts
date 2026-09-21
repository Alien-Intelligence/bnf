/**
 * resolveCorpusProject — the one call a corpus/document/RAG route makes to
 * answer "whose corpus am I reading, and may I still reach it?".
 *
 * A derived project reads its source's corpus. If the grant behind it has been
 * revoked, the honest answer is 409 with an explicit reason — never the source's
 * data, and never an empty result set standing in for a denial
 * (CLAUDE_ERROR_PATTERNS.md §9).
 *
 * Returning the id and the guard together is deliberate: the failure mode of
 * read-only consumption is forgetting one of the two at some call site, and a
 * single call that yields `string | Response` cannot be half-applied.
 *
 * This file is colocated in app/api/ as a private utility (underscore prefix).
 * Next.js only routes files named route.ts/page.tsx — it is never an endpoint.
 */
import { conflict } from "@/lib/api-response"
import { canReachCorpus, corpusProjectId } from "@/lib/authz/corpus-source"

/** The message the UI and the agent both surface for a revoked grant. */
export const CORPUS_ACCESS_REVOKED_MESSAGE =
  "L'accès au corpus partagé a été révoqué."

type CorpusSourceFields = {
  id: string
  corpusSourceId: string | null
  corpusSourceShareId: string | null
}

export function resolveCorpusProject(
  project: CorpusSourceFields,
): string | Response {
  if (!canReachCorpus(project)) return conflict(CORPUS_ACCESS_REVOKED_MESSAGE)
  return corpusProjectId(project)
}
