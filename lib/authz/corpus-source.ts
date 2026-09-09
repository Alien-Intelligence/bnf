// lib/authz/corpus-source.ts
//
// Which project's corpus does this project read?
//
// A *derived* project is a workspace whose corpus, documents and cluster
// dataset belong to another project, and whose sessions, memory and notes are
// its own. Read-only consumption is structural, not a flag: there is no
// "readOnly" boolean anywhere — a project is read-only about its corpus
// exactly when `corpusSourceId` is set.
//
// `corpusProjectId()` is the ONLY way to resolve which project's corpus to
// read. Every corpus/document/RAG read path calls it; missing one is the main
// failure mode of this feature — see CLAUDE.md, "Groups & sharing".
//
// Pure functions: no DB, no `server-only`.

/** The subset of Project these functions need. */
type CorpusSourceFields = {
  id: string
  corpusSourceId: string | null
  corpusSourceShareId: string | null
}

/**
 * The project whose corpus, documents and cluster dataset this project reads.
 * A normal project reads its own; a derived project reads its source's.
 *
 * Note this stays correct after revocation: a revoked derived project still
 * *points* at the source, so callers get a coherent id and the revoked state is
 * signalled separately by `corpusSourceState`. Reads are gated on that state,
 * never on a silently-swapped id.
 */
export function corpusProjectId(project: CorpusSourceFields): string {
  return project.corpusSourceId ?? project.id
}

/** True when this project consumes another project's corpus. */
export function isDerived(project: CorpusSourceFields): boolean {
  return project.corpusSourceId !== null
}

export const CORPUS_SOURCE_STATE = {
  /** A normal project — it owns its corpus. */
  OWN: "own",
  /** Derived, reading the source through a live grant. */
  SHARED: "shared",
  /** Derived, but the grant was revoked. The workspace and its notes survive. */
  REVOKED: "revoked",
} as const

export type CorpusSourceState =
  (typeof CORPUS_SOURCE_STATE)[keyof typeof CORPUS_SOURCE_STATE]

/**
 * The three legal states of (corpusSourceId, corpusSourceShareId). The fourth
 * combination — a share id with no source — is forbidden by the CHECK
 * constraint `project_corpus_source_share_requires_source`.
 */
export function corpusSourceState(
  project: CorpusSourceFields,
): CorpusSourceState {
  if (project.corpusSourceId === null) return CORPUS_SOURCE_STATE.OWN
  if (project.corpusSourceShareId === null) return CORPUS_SOURCE_STATE.REVOKED
  return CORPUS_SOURCE_STATE.SHARED
}

/**
 * True when this project can currently read the corpus it points at. False for
 * a derived project whose share was revoked — the surfaces that read the corpus
 * render an explicit revoked state rather than an empty one, and the agent's
 * corpus tools return a structured error instead of an empty result set
 * (CLAUDE_ERROR_PATTERNS.md §9).
 */
export function canReachCorpus(project: CorpusSourceFields): boolean {
  return corpusSourceState(project) !== CORPUS_SOURCE_STATE.REVOKED
}
