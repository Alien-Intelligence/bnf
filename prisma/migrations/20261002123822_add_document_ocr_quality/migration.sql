-- CreateTable
CREATE TABLE "document_ocr" (
    "ark" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ocr_rate" DOUBLE PRECISION,
    "reason" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL,
    "synced_at" TIMESTAMP(3),
    "next_check_at" TIMESTAMP(3),
    "resync_requested_at" TIMESTAMP(3),
    "sync_attempts" INTEGER NOT NULL DEFAULT 0,
    "outage_count" INTEGER NOT NULL DEFAULT 0,
    "outage_strikes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_ocr_pkey" PRIMARY KEY ("ark")
);

-- CreateTable
CREATE TABLE "document_folio" (
    "ark" TEXT NOT NULL,
    "folio" INTEGER NOT NULL,
    "ocr_source" TEXT NOT NULL,
    "ocr_quality" DOUBLE PRECISION,
    "word_count" INTEGER,

    CONSTRAINT "document_folio_pkey" PRIMARY KEY ("ark","folio")
);

-- CreateIndex
CREATE INDEX "document_ocr_next_check_at_idx" ON "document_ocr"("next_check_at");

-- AddForeignKey
ALTER TABLE "document_folio" ADD CONSTRAINT "document_folio_ark_fkey" FOREIGN KEY ("ark") REFERENCES "document_ocr"("ark") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed vocabularies and ranges, enforced by the database as well as by the
-- app's Zod wire schema (lib/cluster/ocr-quality.ts) and read-time checks
-- (lib/ocr/quality.ts): a row the app cannot read is never written.
ALTER TABLE "document_ocr" ADD CONSTRAINT "document_ocr_status_check"
    CHECK ("status" IN ('pending', 'available', 'building', 'incompatible', 'unavailable', 'quarantined'));
ALTER TABLE "document_ocr" ADD CONSTRAINT "document_ocr_ocr_rate_check"
    CHECK ("ocr_rate" IS NULL OR ("ocr_rate" >= 0 AND "ocr_rate" <= 1));
ALTER TABLE "document_ocr" ADD CONSTRAINT "document_ocr_sync_attempts_check"
    CHECK ("sync_attempts" >= 0);
ALTER TABLE "document_ocr" ADD CONSTRAINT "document_ocr_outage_count_check"
    CHECK ("outage_count" >= 0);
ALTER TABLE "document_ocr" ADD CONSTRAINT "document_ocr_outage_strikes_check"
    CHECK ("outage_strikes" >= 0);
ALTER TABLE "document_folio" ADD CONSTRAINT "document_folio_folio_check"
    CHECK ("folio" >= 1);
ALTER TABLE "document_folio" ADD CONSTRAINT "document_folio_ocr_source_check"
    CHECK ("ocr_source" IN ('alto', 'mistral', 'vision'));
ALTER TABLE "document_folio" ADD CONSTRAINT "document_folio_ocr_quality_check"
    CHECK ("ocr_quality" IS NULL OR ("ocr_quality" >= 0 AND "ocr_quality" <= 1));
ALTER TABLE "document_folio" ADD CONSTRAINT "document_folio_word_count_check"
    CHECK ("word_count" IS NULL OR "word_count" >= 0);
