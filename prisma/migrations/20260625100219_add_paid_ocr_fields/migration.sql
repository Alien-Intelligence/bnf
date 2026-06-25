-- AlterTable
ALTER TABLE "ingest_job" ADD COLUMN     "paid_ocr_actual_usd" DECIMAL(65,30),
ADD COLUMN     "paid_ocr_arks" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "paid_ocr_estimated_usd" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "paid_ocr_budget_usd" DECIMAL(65,30),
ADD COLUMN     "paid_ocr_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paid_ocr_spent_usd" DECIMAL(65,30) NOT NULL DEFAULT 0;
