-- AlterTable
ALTER TABLE "document" ADD COLUMN     "resolve_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resolve_error" TEXT,
ADD COLUMN     "resolve_status" TEXT NOT NULL DEFAULT 'pending',
ALTER COLUMN "title" DROP NOT NULL,
ALTER COLUMN "doc_type" DROP NOT NULL;

-- Backfill: rows that already carry resolved metadata are NOT pending. The new
-- column defaults to 'pending', which is correct only for future stub rows —
-- existing documents (created with a title) are already resolved.
UPDATE "document"
SET "resolve_status" = 'resolved',
    "resolved_at" = COALESCE("resolved_at", NOW())
WHERE "title" IS NOT NULL;

-- CreateIndex
CREATE INDEX "document_resolve_status_project_id_idx" ON "document"("resolve_status", "project_id");
