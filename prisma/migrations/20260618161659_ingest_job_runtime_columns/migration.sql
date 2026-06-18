-- AlterTable
ALTER TABLE "ingest_job" ADD COLUMN     "added_arks" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "callback_secret" TEXT,
ADD COLUMN     "cluster_job_id" TEXT,
ADD COLUMN     "removed_arks" TEXT[] DEFAULT ARRAY[]::TEXT[];
