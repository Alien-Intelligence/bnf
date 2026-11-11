// lib/agent/tools/write-failure.ts
// A failed corpus or buffer write, as the model reads it.
//
// The SDK turns an exception thrown by a handler into the text
// `Tool "buffer_commit" failed: <raw Prisma message>` — a transaction-timeout
// message that names a 5000 ms limit and the elapsed time. A model reads that as
// a size cap (prod, 2026-10-27: « le serveur plafonne à ~500 documents »), then
// discards candidates to route around a limit that does not exist.
//
// So every tool that mutates the corpus or the buffer runs its write through `guardCorpusWrite`: a
// failure becomes the one failure shape of failure.ts (`success: false`, a stable
// `code`, `retryable`, a French message that says it is a SYSTEM error, never a
// size limit) and is logged with the real error server-side (CLAUDE_ERROR_PATTERNS
// §15: coerce, never throw out of the tool loop; never swallow).
import "server-only"

import { Prisma } from "@/lib/generated/prisma/client"
import { FilterValueError } from "@/lib/filters"
import { SYSTEM_FAILURE_CODE, toolSystemFailure, type ToolSystemFailure } from "./failure"

/** What a failed write left untouched, named in the message the model reads. */
export const WRITE_INTACT = {
  /**
   * buffer_commit: the failure may land after the corpus advanced or the rows
   * were marked, so the only claim true in EVERY case is idempotence: the
   * failure discards nothing, and re-running the commit counts the ARKs already
   * versed as duplicates (CorpusService.addArks dedupes; markCommitted only
   * moves rows still `candidate`).
   */
  BUFFER:
    "Cet échec n'a écarté ni retiré aucun candidat, et la validation est idempotente " +
    "(les ARK déjà versés au corpus comptent comme doublons) : la relancer à l'identique est sans risque.",
  /** corpus_add / corpus_remove*: the version advance is one transaction. */
  CORPUS: "Le corpus est inchangé : l'opération a été annulée.",
  /** buffer_discard: one UPDATE statement, so it applies to every row or to none. */
  DISCARD: "Aucun candidat n'a été écarté (une seule requête, annulée en bloc) : le tampon est inchangé.",
  /**
   * buffer_add: staging is several statements (insert, then one guarded
   * transaction of refreshes and transitions), so a failure may leave some ARKs
   * staged. The claims true in every case: nothing was discarded or removed, and
   * the identical re-run is safe (BufferQueries.insertMany skips duplicates;
   * existing rows are refreshed and moved by guarded updates).
   */
  STAGE:
    "Cet échec n'a écarté ni retiré aucun candidat ; certains ARK ont pu être déposés avant l'erreur, " +
    "et relancer le même dépôt à l'identique est sans risque (les ARK déjà déposés sont ignorés ou rafraîchis).",
  /** buffer_clear: one DELETE statement, so it applies to every row or to none. */
  CLEAR: "Aucun candidat n'a été supprimé (une seule requête, annulée en bloc) : le tampon est inchangé.",
} as const
export type WriteIntact = (typeof WRITE_INTACT)[keyof typeof WRITE_INTACT]

/** Every Prisma request-error code this module names, once. */
const PRISMA_ERROR_CODE = {
  /** An interactive transaction outlived its timeout. */
  TRANSACTION_TIMEOUT: "P2028",
  /** A write conflict or deadlock. */
  WRITE_CONFLICT: "P2034",
  /** The database server cannot be reached. */
  UNREACHABLE: "P1001",
  /** The database server timed out. */
  SERVER_TIMEOUT: "P1002",
  /** An operation timed out. */
  OPERATION_TIMEOUT: "P1008",
  /** The server closed the connection. */
  CONNECTION_CLOSED: "P1017",
} as const

/** The errors a plain re-issue can outlast. */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set(Object.values(PRISMA_ERROR_CODE))

function prismaCode(err: unknown): string | null {
  return err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null
}

function failureMessage(intact: WriteIntact, retryable: boolean): string {
  const next = retryable
    ? "Propose au bibliothécaire de relancer le MÊME appel à l'identique, puis attends sa réponse."
    : "Signale l'erreur telle quelle au bibliothécaire et arrête-toi."
  return (
    "ÉCHEC SYSTÈME (erreur interne du serveur) : ce n'est PAS une limite de taille ni de volume, " +
    `le lot est valide. ${intact} ` +
    "N'écarte, ne retire, ne dé-stage et ne découpe AUCUN candidat pour contourner l'erreur. " +
    next
  )
}

/** The failure result for `err`, after logging it with the real error. */
export function writeFailure(tool: string, err: unknown, intact: WriteIntact): ToolSystemFailure {
  console.error(`[${tool}] write failed`, err)
  const code = prismaCode(err)
  const retryable = code !== null && TRANSIENT_PRISMA_CODES.has(code)
  return toolSystemFailure(
    code === PRISMA_ERROR_CODE.TRANSACTION_TIMEOUT ? SYSTEM_FAILURE_CODE.TRANSACTION_TIMEOUT : SYSTEM_FAILURE_CODE.SYSTEM_ERROR,
    retryable,
    failureMessage(intact, retryable),
  )
}

/** The outcome of a guarded write: its value, or the result to hand the model. */
export type WriteAttempt<T> = { ok: true; value: T } | { ok: false; result: ToolSystemFailure }

/**
 * Run ONLY the write (the service call that advances the corpus), so the
 * message never claims "unchanged" for a failure of a step after it. Anything
 * it throws becomes `{ ok: false, result }`. A `FilterValueError` is the
 * caller's input being refused (an `invalid_params` refusal built by
 * `refusingBadFilterValues`), not a system failure, so it passes through.
 */
export async function attemptWrite<T>(
  tool: string,
  intact: WriteIntact,
  run: () => Promise<T>,
): Promise<WriteAttempt<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    if (err instanceof FilterValueError) throw err
    return { ok: false, result: writeFailure(tool, err, intact) }
  }
}
