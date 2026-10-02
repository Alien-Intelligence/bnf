-- CreateTable
CREATE TABLE "document_ocr" (
    "ark" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ocr_rate" DOUBLE PRECISION,
    "reason" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL,
    "synced_at" TIMESTAMP(3),

    CONSTRAINT "document_ocr_pkey" PRIMARY KEY ("ark")
);

-- CreateTable
CREATE TABLE "document_folio" (
    "ark" TEXT NOT NULL,
    "folio" INTEGER NOT NULL,
    "ocr_source" TEXT NOT NULL,
    "ocr_quality" DOUBLE PRECISION,
    "word_count" INTEGER,

    CONSTRAINT "document_folio_pkey" PRIMARY KEY ("ark","folio")
);

-- CreateIndex
CREATE INDEX "document_ocr_status_checked_at_idx" ON "document_ocr"("status", "checked_at");

-- AddForeignKey
ALTER TABLE "document_folio" ADD CONSTRAINT "document_folio_ark_fkey" FOREIGN KEY ("ark") REFERENCES "document_ocr"("ark") ON DELETE CASCADE ON UPDATE CASCADE;
