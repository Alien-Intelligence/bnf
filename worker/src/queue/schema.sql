-- Track 2 — queue + per-document state.
-- Applied idempotently from migrate.ts. Safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Track 2 lives in its own schema so it doesn't collide with the main bnf
-- Prisma app (which also owns an `ingest_job` table in this shared dev DB).
CREATE SCHEMA IF NOT EXISTS sandbox_ingest;
SET LOCAL search_path = sandbox_ingest, public;

CREATE TABLE IF NOT EXISTS sandbox_ingest.ingest_job (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      TEXT NOT NULL,
  status          TEXT NOT NULL,
  total_docs      INT NOT NULL DEFAULT 0,
  added_count     INT NOT NULL DEFAULT 0,
  removed_count   INT NOT NULL DEFAULT 0,
  done_count      INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  skipped_count   INT NOT NULL DEFAULT 0,
  chunks_written  INT NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sandbox_ingest.document_ingest_job (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_job_id   UUID NOT NULL REFERENCES sandbox_ingest.ingest_job(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  ark             TEXT NOT NULL,
  pipeline        TEXT,
  status          TEXT NOT NULL,
  skip_reason     TEXT,
  content_hash    TEXT,
  entry_id        INT,
  chunks_written  INT NOT NULL DEFAULT 0,
  attempts        INT NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ingest_job_id, ark)
);
CREATE INDEX IF NOT EXISTS document_ingest_job_status_idx
  ON sandbox_ingest.document_ingest_job(project_id, ark, status);
CREATE INDEX IF NOT EXISTS document_ingest_job_parent_idx
  ON sandbox_ingest.document_ingest_job(ingest_job_id);

CREATE TABLE IF NOT EXISTS sandbox_ingest.document_ingest_state (
  project_id      TEXT NOT NULL,
  ark             TEXT NOT NULL,
  status          TEXT NOT NULL,
  pipeline        TEXT,
  content_hash    TEXT,
  last_job_id     UUID,
  entry_id        INT,
  chunks_written  INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, ark)
);

-- cluster_ingest_request — bookkeeping for the HTTP-facing worker API.
-- One row per inbound POST /ingest call from the app. Stores everything the
-- runner needs to emit signed progress callbacks back to the app after the
-- request has returned (callbackUrl + per-job HMAC secret), plus the parent
-- sandbox ingest_job id so the runner can compute aggregate stage progress.
CREATE TABLE IF NOT EXISTS sandbox_ingest.cluster_ingest_request (
  cluster_job_id    TEXT PRIMARY KEY,
  app_job_id        TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  ingest_job_id     UUID NOT NULL REFERENCES sandbox_ingest.ingest_job(id) ON DELETE CASCADE,
  target_version_id TEXT NOT NULL,
  callback_url      TEXT NOT NULL,
  callback_secret   TEXT NOT NULL,
  total_docs        INT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running',  -- running | done | failed | canceled
  canceled          BOOLEAN NOT NULL DEFAULT false,
  last_progress_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cluster_ingest_request_ingest_job_idx
  ON sandbox_ingest.cluster_ingest_request(ingest_job_id);
CREATE INDEX IF NOT EXISTS cluster_ingest_request_app_job_idx
  ON sandbox_ingest.cluster_ingest_request(app_job_id);
