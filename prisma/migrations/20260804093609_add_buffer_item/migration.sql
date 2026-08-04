-- CreateTable
CREATE TABLE "buffer_item" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "ark" TEXT NOT NULL,
    "title" TEXT,
    "year" INTEGER,
    "doc_type" TEXT,
    "lang" TEXT,
    "source" TEXT,
    "snippet" TEXT,
    "origin_tool" TEXT NOT NULL,
    "origin_query" TEXT,
    "added_by_session_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buffer_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "buffer_item_project_id_status_idx" ON "buffer_item"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "buffer_item_project_id_ark_key" ON "buffer_item"("project_id", "ark");

-- AddForeignKey
ALTER TABLE "buffer_item" ADD CONSTRAINT "buffer_item_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
