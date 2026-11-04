-- The data-cluster MCP (mcp-data-cluster 0.3.0, SDS-1031) names a dataset by a
-- composite string "cluster:dataset" and refuses the cluster-local integer ids
-- this column used to cache. Every existing value is such an integer: it is
-- set to NULL (not converted to text) because nothing here knows the cluster
-- prefix, and RealRagRunner's resolveDatasetId re-resolves a NULL lazily by the
-- dataset slug `bnf-<projectId>` and re-caches the composite id. A plain
-- ALTER ... TYPE would keep the stale integers as strings the MCP would reject.
--
-- Locking: ACCESS EXCLUSIVE on "project" for the duration of the statement; the
-- table is small (one row per project) so the rewrite is instantaneous.

-- AlterTable
ALTER TABLE "project" ALTER COLUMN "cluster_dataset_id" SET DATA TYPE TEXT USING NULL;

-- Rollback (Prisma has no down migrations; run by hand, then delete this
-- migration's row from "_prisma_migrations"). The composite ids cannot be
-- converted back to cluster-local integers, so the column is emptied; the
-- previous app version re-resolves it lazily by slug:
--   ALTER TABLE "project" ALTER COLUMN "cluster_dataset_id" SET DATA TYPE INTEGER USING NULL;
