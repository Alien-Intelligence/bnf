-- AlterTable
ALTER TABLE "project" ALTER COLUMN "paid_ocr_enabled" SET DEFAULT true;

-- Backfill: authorize paid OCR on existing projects too (the per-ingestion
-- confirmation dialog remains the actual spend gate). Flip only rows still at
-- the old default so an intentional per-project opt-out is never overwritten.
UPDATE "project" SET "paid_ocr_enabled" = true WHERE "paid_ocr_enabled" = false;
