-- AlterTable
ALTER TABLE "buffer_item" ADD COLUMN     "ark_kind" TEXT,
ADD COLUMN     "catalogue_url" TEXT,
ADD COLUMN     "classifier_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creator" TEXT,
ADD COLUMN     "date_label" TEXT,
ADD COLUMN     "doc_type_raw" TEXT,
ADD COLUMN     "enrich_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "enrich_error" TEXT,
ADD COLUMN     "enrich_status" TEXT,
ADD COLUMN     "gallica_url" TEXT,
ADD COLUMN     "publisher" TEXT,
ADD COLUMN     "search_collapsing" BOOLEAN,
ADD COLUMN     "subjects" TEXT,
ADD COLUMN     "year_end" INTEGER;

-- CreateIndex
CREATE INDEX "buffer_item_project_id_enrich_status_idx" ON "buffer_item"("project_id", "enrich_status");

-- CreateIndex
CREATE INDEX "buffer_item_classifier_version_idx" ON "buffer_item"("classifier_version");

-- Hand-written (the only non-generated statement in this migration).
-- MARC bibliographic language codes were stored verbatim in document.lang
-- before canonicalLang (lib/mcp/vocab.ts): the old map knew only the ISO 639-2
-- terminology column, so German documents were 'ger' and matched no 'de'
-- filter. Deterministic and idempotent: only these exact codes (and the two
-- spellings of the French name) change, to the value canonicalLang gives them.
UPDATE "document" SET "lang" = CASE lower("lang")
  WHEN 'ger' THEN 'de' WHEN 'dut' THEN 'nl' WHEN 'cze' THEN 'cs' WHEN 'rum' THEN 'ro'
  WHEN 'per' THEN 'fa' WHEN 'fre' THEN 'fr' WHEN 'fra' THEN 'fr' WHEN 'eng' THEN 'en'
  WHEN 'lat' THEN 'la' WHEN 'slo' THEN 'sk' WHEN 'scc' THEN 'sr' WHEN 'scr' THEN 'hr'
  WHEN 'wel' THEN 'cy' WHEN 'ice' THEN 'is' WHEN 'arm' THEN 'hy' WHEN 'geo' THEN 'ka'
  WHEN 'may' THEN 'ms' WHEN 'tib' THEN 'bo' WHEN 'baq' THEN 'eu' WHEN 'alb' THEN 'sq'
  WHEN 'mac' THEN 'mk' WHEN 'bur' THEN 'my' WHEN 'mao' THEN 'mi'
  WHEN 'français' THEN 'fr' WHEN 'francais' THEN 'fr' END
WHERE lower("lang") IN (
  'ger','dut','cze','rum','per','fre','fra','eng','lat','slo','scc','scr','wel','ice',
  'arm','geo','may','tib','baq','alb','mac','bur','mao','français','francais'
);
