-- Locking, accepted at the current table size: prod "corpus_membership" is
-- ~2.1M rows / 662 MB, so the plain CREATE INDEX holds its SHARE lock (writes
-- blocked, reads allowed) for seconds. Not split into a CONCURRENTLY migration:
-- Prisma runs a migration in a single transaction, where CONCURRENTLY fails.

-- CreateIndex
CREATE INDEX "corpus_membership_project_id_ark_idx" ON "corpus_membership"("project_id", "ark");

-- Rollback (Prisma has no down migrations; run by hand, then delete this
-- migration's row from "_prisma_migrations"):
--   DROP INDEX "corpus_membership_project_id_ark_idx";
