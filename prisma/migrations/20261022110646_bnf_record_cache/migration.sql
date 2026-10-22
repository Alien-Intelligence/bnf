-- CreateTable
CREATE TABLE "bnf_record" (
    "ark" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bnf_record_pkey" PRIMARY KEY ("ark")
);

-- Seed from the records the resolver already fetched. Only rows with OAI
-- provenance (`gallica_typedoc` is read from the OAI record header) are copied:
-- manifest-derived rows have no typedoc and would spread null subtypes. One row
-- per ARK, the most recently resolved. raw_metadata is the unnormalized BnF
-- payload, so it is the cache payload as is. No network call: the entries carry
-- no `ocr_source`, so a commit-time resolve re-runs the OCR rule on them
-- (a manifest call only for text-like documents OAI does not mark "mode texte").
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
