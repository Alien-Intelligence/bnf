-- DropIndex
DROP INDEX "document_resolve_status_project_id_idx";

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "next_resolve_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "document_resolve_status_next_resolve_at_project_id_idx" ON "document"("resolve_status", "next_resolve_at", "project_id");

-- Rollback (Prisma has no down migrations; run by hand, then delete this
-- migration's row from "_prisma_migrations"):
--   DROP INDEX "document_resolve_status_next_resolve_at_project_id_idx";
--   ALTER TABLE "document" DROP COLUMN "next_resolve_at";
--   CREATE INDEX "document_resolve_status_project_id_idx" ON "document"("resolve_status", "project_id");
