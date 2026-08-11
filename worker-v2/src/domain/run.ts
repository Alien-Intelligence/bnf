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
  /**
   * Consecutive terminal-callback POST failures (TerminalEmitter.emit's catch
   * path). Drives the dead-callback give-up: past
   * RECONCILER_MAX_CALLBACK_FAILURES the emitter cancels the run instead of
   * letting the reconciler sweep re-drive a permanently-dead callback URL
   * forever. See the dead-callback give-up item,
   * ai-memories/tech/repos/bnf/ingest-hardening.
   */
  terminalPostFailures: number;
}

export interface RunStore {
  /** Create the run row (idempotent on runId — a redelivered submit is a no-op). */
  create(input: IngestRunInput): Promise<void>;
  get(runId: string): Promise<IngestRun | null>;
  /**
   * Look up the run already open for a given app job, if any. Used by the
   * HTTP ingress to make `POST /ingest` idempotent on `appJobId`: an app-side
   * retry (after a client timeout, or after the app's own submit failed to
   * receive the response) must return the SAME run rather than opening a
   * second one and re-seeding the same ARKs a second time (audit finding
   * F19). Returns the oldest matching run if more than one somehow exists.
   */
  getByAppJobId(appJobId: string): Promise<IngestRun | null>;
  /**
   * Every run that has NOT reached its terminal callback and was not canceled —
   * i.e. every run the app is still waiting on. This is the reconciliation sweep's
   * entry point (live/reconciler.ts): before it, `checkRun` was reachable ONLY
   * from a live stage outcome, so a single lost transition stranded the run
   * forever (F8, ai-memories/tech/repos/bnf/ingest-hardening). Oldest first, so a
   * long-wedged run is re-driven before a fresh one.
   */
  listActiveRuns(): Promise<IngestRun[]>;
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
  /**
   * Increment the run's terminal-callback failure count and return the new
   * total. Called from TerminalEmitter.emit's catch path on every failed POST
   * (dead-callback give-up, ai-memories/tech/repos/bnf/ingest-hardening) — a
   * run whose callback URL is permanently dead would otherwise be re-driven by
   * every reconciler sweep forever, with no resolution and no signal beyond log
   * spam. A no-op (returns 0) if the run doesn't exist.
   */
  incrementTerminalPostFailures(runId: string): Promise<number>;
}
