-- Hand-written data fix (no schema change; created with
-- `npx prisma migrate dev --create-only --name document_iso_date_year`).
--
-- parseBnfDate (lib/mcp/normalize.ts) had no rule for a full ISO date, which is
-- how Gallica dates a press ISSUE ("1937-07-12"). Such documents were stored
-- with the date in date_label and year NULL, so they were invisible to year
-- filters and the period histogram. The parser now yields the year; this
-- backfills the rows written before it, with the same rule. Deterministic and
-- idempotent: only rows whose year is still NULL and whose label is exactly an
-- ISO date change.
UPDATE "document"
SET "year" = CAST(substr("date_label", 1, 4) AS INTEGER)
WHERE "year" IS NULL
  AND "date_label" ~ '^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$';

-- Buffer rows carry the same label once a search re-surfaces them; rows that
-- already store one are fixed the same way.
UPDATE "buffer_item"
SET "year" = CAST(substr("date_label", 1, 4) AS INTEGER)
WHERE "year" IS NULL
  AND "date_label" ~ '^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$';
