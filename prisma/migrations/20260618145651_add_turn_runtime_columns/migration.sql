-- AlterTable
ALTER TABLE "message" ADD COLUMN     "thinking" TEXT,
ADD COLUMN     "usage" JSONB;

-- AlterTable
ALTER TABLE "tool_call" ADD COLUMN     "server_name" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'custom';
