-- AlterTable
ALTER TABLE "ingest_job" ADD COLUMN     "excluded_arks" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "excluded_count" INTEGER;
