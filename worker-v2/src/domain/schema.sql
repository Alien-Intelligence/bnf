-- Worker V2 per-doc state — the one stateful piece of the pipeline (the Monitor's
-- fan-in counter + the doc lifecycle status). Lives in its own schema alongside
-- pg-boss, sharing the bundled Postgres. Applied idempotently at worker startup.
--
-- Folios are a separate table keyed (doc_job_id, ordre) so recording a folio is
-- idempotent (INSERT ON CONFLICT DO NOTHING — first write wins) and a redelivered
-- FolioResult never double-counts. The fan-in tally + fail-ratio are derived from
-- it; citations read the ok folios back in ordre order.

CREATE SCHEMA IF NOT EXISTS sandbox_ingest_v2;

-- One ingest_run per app ingest submission. Holds the app↔worker callback
-- coordinates so the terminal progress event can be HMAC-signed and POSTed back,
-- and groups the run's docs (run_id on the doc rows) so the read-model + the
-- completion detector scope per run rather than per project. `terminal_emitted`
-- is the idempotency latch: exactly one terminal callback per run (claimed by a
-- conditional UPDATE). `canceled` suppresses the terminal callback after an
-- app-side cancel.
CREATE TABLE IF NOT EXISTS sandbox_ingest_v2.ingest_run (
  run_id            text PRIMARY KEY,        -- == clusterJobId returned to the app
  app_job_id        text NOT NULL,           -- the app IngestJob id (1:1 with a run)
  project_id        text NOT NULL,
  callback_url      text NOT NULL,
  callback_secret   text NOT NULL,
  target_version_id text NOT NULL,
  total_docs        integer NOT NULL,
  terminal_emitted  boolean NOT NULL DEFAULT false,
  canceled          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sandbox_ingest_v2.document_ingest_job_v2 (
  doc_job_id     text PRIMARY KEY,
  run_id         text,                       -- groups docs by ingest_run (null for seed-CLI docs)
  project_id     text NOT NULL,
  ark            text NOT NULL,
  lane           text,                       -- text | vision | mistral (null until planned)
  status         text NOT NULL DEFAULT 'queued',
  pages_expected integer,
  meta           jsonb,
  error          text,
  skip_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- run_id added after the fact for an existing schema (idempotent — the column is
-- in the CREATE above for fresh installs; this covers an already-migrated DB).
ALTER TABLE sandbox_ingest_v2.document_ingest_job_v2
  ADD COLUMN IF NOT EXISTS run_id text;

CREATE INDEX IF NOT EXISTS document_ingest_job_v2_project_status_idx
  ON sandbox_ingest_v2.document_ingest_job_v2 (project_id, status);

CREATE INDEX IF NOT EXISTS document_ingest_job_v2_run_status_idx
  ON sandbox_ingest_v2.document_ingest_job_v2 (run_id, status);

CREATE TABLE IF NOT EXISTS sandbox_ingest_v2.document_folio_v2 (
  doc_job_id text NOT NULL
    REFERENCES sandbox_ingest_v2.document_ingest_job_v2 (doc_job_id) ON DELETE CASCADE,
  ordre      integer NOT NULL,
  ok         boolean NOT NULL,
  PRIMARY KEY (doc_job_id, ordre)
);
