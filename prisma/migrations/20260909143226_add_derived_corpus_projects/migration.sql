-- AlterTable
ALTER TABLE "project" ADD COLUMN     "corpus_source_id" TEXT,
ADD COLUMN     "corpus_source_share_id" TEXT;

-- CreateIndex
CREATE INDEX "project_corpus_source_id_idx" ON "project"("corpus_source_id");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_corpus_source_id_fkey" FOREIGN KEY ("corpus_source_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_corpus_source_share_id_fkey" FOREIGN KEY ("corpus_source_share_id") REFERENCES "project_share"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A corpus-source share may only be recorded alongside the source it grants
-- access to. Encodes the three legal states of (corpus_source_id,
-- corpus_source_share_id): (null,null) own, (set,set) shared, (set,null)
-- revoked. See lib/authz/corpus-source.ts.
ALTER TABLE "project" ADD CONSTRAINT "project_corpus_source_share_requires_source"
  CHECK ("corpus_source_share_id" IS NULL OR "corpus_source_id" IS NOT NULL);
