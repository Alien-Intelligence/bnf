// lib/agent/tools/write-failure.ts
// A failed corpus write, as the model reads it.
//
// The SDK turns an exception thrown by a handler into the text
// `Tool "buffer_commit" failed: <raw Prisma message>` — a transaction-timeout
// message that names a 5000 ms limit and the elapsed time. A model reads that as
// a size cap (prod, 2026-10-27: « le serveur plafonne à ~500 documents »), then
// discards candidates to route around a limit that does not exist.
//
// So every corpus-advancing tool runs its write through `guardCorpusWrite`: a
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
  /** buffer_commit: the staged candidates are still staged. */
  BUFFER: "Le tampon est intact : aucun candidat n'a été retiré ni écarté.",
  /** corpus_add / corpus_remove*: the version advance is one transaction. */
  CORPUS: "Le corpus est inchangé : l'opération a été annulée.",
} as const
export type WriteIntact = (typeof WRITE_INTACT)[keyof typeof WRITE_INTACT]

/**
 * Prisma request errors a plain re-issue can outlast: an expired transaction
 * (P2028), a write conflict / deadlock (P2034) and a connection or timeout
 * failure (P1001, P1002, P1008, P1017).
 */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set(["P2028", "P2034", "P1001", "P1002", "P1008", "P1017"])
const PRISMA_TRANSACTION_TIMEOUT = "P2028"

function prismaCode(err: unknown): string | null {
  return err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null
}

function failureMessage(intact: WriteIntact, retryable: boolean): string {
  const retry = retryable
    ? "Un nouvel essai identique peut réussir : propose-le au bibliothécaire sans modifier le lot. "
    : ""
  return (
    "ÉCHEC SYSTÈME (erreur interne du serveur) : ce n'est PAS une limite de taille ni de volume, " +
    `le lot est valide. ${intact} ${retry}` +
    "N'écarte, ne retire, ne dé-stage et ne découpe AUCUN candidat pour contourner l'erreur : " +
    "signale-la telle quelle au bibliothécaire et arrête-toi."
  )
}

/** The failure result for `err`, after logging it with the real error. */
export function corpusWriteFailure(tool: string, err: unknown, intact: WriteIntact): ToolSystemFailure {
  console.error(`[${tool}] write failed`, err)
  const code = prismaCode(err)
  const retryable = code !== null && TRANSIENT_PRISMA_CODES.has(code)
  return toolSystemFailure(
    code === PRISMA_TRANSACTION_TIMEOUT ? SYSTEM_FAILURE_CODE.TRANSACTION_TIMEOUT : SYSTEM_FAILURE_CODE.SYSTEM_ERROR,
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
export async function attemptCorpusWrite<T>(
  tool: string,
  intact: WriteIntact,
  run: () => Promise<T>,
): Promise<WriteAttempt<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    if (err instanceof FilterValueError) throw err
    return { ok: false, result: corpusWriteFailure(tool, err, intact) }
  }
}
