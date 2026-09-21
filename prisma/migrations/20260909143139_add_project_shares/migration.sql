-- CreateTable
CREATE TABLE "project_share" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_share_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_share_group_id_idx" ON "project_share"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_share_project_id_group_id_key" ON "project_share"("project_id", "group_id");

-- AddForeignKey
ALTER TABLE "project_share" ADD CONSTRAINT "project_share_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_share" ADD CONSTRAINT "project_share_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
