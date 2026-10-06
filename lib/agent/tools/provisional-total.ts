// lib/agent/tools/provisional-total.ts
// What buffer_commit and corpus_add tell the agent about the total they report
// (Track E Phase 6, feedback #10c). Village suisse: the commit said 58, the
// canonicaliser replaced 16 notices by their digitized documents 31 s later,
// the head held 44 — and the agent announced 58 because nothing said the
// number would move. Pure, so the wording is tested once for both tools.

/** The fields both mutating corpus tools add to their result. */
export type ProvisionalTotal = {
  /** Head members still waiting for cb→Gallica canonicalisation. */
  canonicalizationPending: number
  /** True while the reported `total` (or its composition) can still change. */
  totalIsProvisional: boolean
  /** What to do before quoting a number — present only when provisional. */
  next_step?: string
}

export function provisionalTotal(canonicalizationPending: number, pending: number): ProvisionalTotal {
  const totalIsProvisional = canonicalizationPending > 0 || pending > 0
  if (!totalIsProvisional) return { canonicalizationPending, totalIsProvisional }
  const parts: string[] = []
  if (canonicalizationPending > 0) {
    parts.push(
      `Le total peut encore changer : ${canonicalizationPending} notice(s) catalogue peuvent être ` +
        "remplacées par leur document numérisé dans les secondes qui suivent (doublons fusionnés).",
    )
  }
  if (pending > 0) {
    parts.push(`Les métadonnées de ${pending} document(s) sont encore en cours de résolution.`)
  }
  parts.push("Relis `corpus_get_state` avant d'annoncer un nombre de documents.")
  return { canonicalizationPending, totalIsProvisional, next_step: parts.join(" ") }
}
