-- CreateTable
CREATE TABLE "bnf_record" (
    "ark" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bnf_record_pkey" PRIMARY KEY ("ark")
);

-- Seed from the records the resolver already fetched. The ONLY thing copied out
-- of "document" is `raw_metadata`, the unnormalized BnF payload, i.e. exactly
-- what the BnF published. No project field (indexed_at, index_error,
-- canonical_status, project_id) reaches "bnf_record"; the project row is only
-- the place the published payload was kept (playbook/sharing.md). One-time
-- exception, decided by Leo (SDS-945).
--
-- Only rows with OAI provenance (`gallica_typedoc` is read from the OAI record
-- header) are copied: manifest-derived rows have no typedoc and would spread
-- null subtypes. One row per ARK, the most recently resolved; `fetched_at` is
-- informational only (no read filters on it), so a null "resolved_at" falls
-- back to the migration time.
--
-- Every seeded entry is a STAGING entry: `ocr_source` is a field of this
-- release, so no existing "raw_metadata" carries it, and the commit-time
-- resolver keys on its absence (BnfRecordService.needsOcrRule) to re-run the
-- OCR rule (a manifest call only for text-like documents OAI does not mark
-- "mode texte"). No network call happens here.
--
-- Cost, accepted at the current size: prod "document" is 175,909 rows / 154 MB
-- and the seed matches 6,328 distinct ARKs. The seq scan and the sort take
-- seconds, so the statement is neither batched nor given a statement_timeout.
INSERT INTO "bnf_record" ("ark", "payload", "source", "fetched_at")
SELECT DISTINCT ON ("ark") "ark", "raw_metadata", 'oai_gallica', COALESCE("resolved_at", CURRENT_TIMESTAMP)
FROM "document"
WHERE "resolve_status" = 'resolved'
  AND jsonb_typeof("raw_metadata") = 'object'
  AND "raw_metadata" ? 'gallica_typedoc'
ORDER BY "ark", "resolved_at" DESC NULLS LAST;

-- Rollback (Prisma has no down migrations; run by hand, then delete this
-- migration's row from "_prisma_migrations"):
--   DROP TABLE "bnf_record";
