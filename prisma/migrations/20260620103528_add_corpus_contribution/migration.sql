-- CreateTable
CREATE TABLE "corpus_contribution" (
    "project_id" TEXT NOT NULL,
    "ark" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corpus_contribution_pkey" PRIMARY KEY ("project_id","ark","session_id")
);

-- CreateIndex
CREATE INDEX "corpus_contribution_session_id_idx" ON "corpus_contribution"("session_id");

-- AddForeignKey
ALTER TABLE "corpus_contribution" ADD CONSTRAINT "corpus_contribution_project_id_ark_fkey" FOREIGN KEY ("project_id", "ark") REFERENCES "document"("project_id", "ark") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corpus_contribution" ADD CONSTRAINT "corpus_contribution_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "app_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
