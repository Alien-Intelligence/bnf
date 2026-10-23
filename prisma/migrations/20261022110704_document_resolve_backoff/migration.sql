-- Locking, accepted at the current table size: prod "document" is 175,909 rows
-- / 154 MB, so the plain CREATE INDEX holds its SHARE lock (writes blocked,
-- reads allowed) for seconds, and ADD COLUMN without a default is metadata-only
-- under a brief ACCESS EXCLUSIVE lock. The old index is dropped in the same
-- transaction, so the drainer never runs without a supporting index. This is
-- not split into CONCURRENTLY migrations: Prisma runs a migration in a single
-- transaction, where CONCURRENTLY fails.

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
