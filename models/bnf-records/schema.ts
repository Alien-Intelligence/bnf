// models/bnf-records/schema.ts
// The global BnF record cache: one public record per ARK, shared by every
// project. Prisma model `BnfRecord` is the source of truth for the table; this
// file holds the query shape and the domain constants.
import type { Prisma } from "@/lib/generated/prisma/client"

/** Where a cached record came from (BnfRecord.source). */
export const BNF_RECORD_SOURCE = {
  OAI_GALLICA: "oai_gallica",
  CATALOGUE_SRU: "catalogue_sru",
} as const
export type BnfRecordSource = (typeof BNF_RECORD_SOURCE)[keyof typeof BNF_RECORD_SOURCE]

/** What a reader needs of a cached record. `fetchedAt` is informational: no read filters on it. */
export const bnfRecordRow = {
  select: { ark: true, payload: true, source: true },
} satisfies Prisma.BnfRecordDefaultArgs
export type BnfRecordRow = Prisma.BnfRecordGetPayload<typeof bnfRecordRow>

/** One record to store: the unnormalized BnF payload of an ARK. */
export type BnfRecordWrite = {
  ark: string
  payload: Prisma.InputJsonObject
  source: BnfRecordSource
}
