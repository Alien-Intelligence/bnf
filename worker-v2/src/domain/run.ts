/**
 * Ingest-run store — one row per app ingest submission, holding the app↔worker
 * callback coordinates and the terminal-emit latch. A run groups its docs (via
 * run_id on the doc rows) so the read-model and the completion detector scope per
 * run, not per project. Two implementations (pg for prod, memory for tests) behind
 * one interface, mirroring the DocStateStore split.
 *
 * The latch (`markTerminalEmitted`) is an atomic conditional UPDATE so exactly one
 * caller wins the terminal callback even under concurrent completion checks —
 * the same first-write-wins discipline the Monitor uses for routing.
 */

/** What the HTTP ingress hands in to open a run. */
export interface IngestRunInput {
  runId: string;
  appJobId: string;
  projectId: string;
  callbackUrl: string;
  callbackSecret: string;
  targetVersionId: string;
  totalDocs: number;
}

export interface IngestRun extends IngestRunInput {
  terminalEmitted: boolean;
  canceled: boolean;
}

export interface RunStore {
  /** Create the run row (idempotent on runId — a redelivered submit is a no-op). */
  create(input: IngestRunInput): Promise<void>;
  get(runId: string): Promise<IngestRun | null>;
  /**
   * Atomically claim the terminal callback: flip terminal_emitted false→true,
   * returning true ONLY for the caller that won. A non-winning caller (already
   * emitted, or canceled) gets false and must not POST.
   */
  markTerminalEmitted(runId: string): Promise<boolean>;
  /** Release the latch so a later completion check can retry (terminal POST failed). */
  resetTerminalEmitted(runId: string): Promise<void>;
  /** Mark the run canceled — suppresses the terminal callback. */
  markCanceled(runId: string): Promise<void>;
}
