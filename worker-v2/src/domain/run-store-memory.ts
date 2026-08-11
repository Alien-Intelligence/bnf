/**
 * In-memory RunStore for unit tests — single-threaded JS makes the conditional
 * latch trivially atomic. Same contract as PgRunStore so the ingress, the
 * completion monitor, and the emitter are impl-agnostic.
 */
import type { IngestRun, IngestRunInput, RunStore } from "./run.js";

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, IngestRun>();

  async create(input: IngestRunInput): Promise<void> {
    if (this.runs.has(input.runId)) return; // idempotent on runId
    this.runs.set(input.runId, { ...input, terminalEmitted: false, canceled: false });
  }

  async get(runId: string): Promise<IngestRun | null> {
    const r = this.runs.get(runId);
    return r ? { ...r } : null;
  }

  async getByAppJobId(appJobId: string): Promise<IngestRun | null> {
    // Map insertion order is iteration order in JS — the first match is the
    // oldest, matching the pg implementation's ORDER BY created_at ASC.
    for (const r of this.runs.values()) {
      if (r.appJobId === appJobId) return { ...r };
    }
    return null;
  }

  async listActiveRuns(): Promise<IngestRun[]> {
    // Insertion order == creation order in JS, matching the pg ORDER BY created_at.
    return [...this.runs.values()]
      .filter((r) => !r.terminalEmitted && !r.canceled)
      .map((r) => ({ ...r }));
  }

  async markTerminalEmitted(runId: string): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r || r.terminalEmitted || r.canceled) return false;
    r.terminalEmitted = true;
    return true;
  }

  async resetTerminalEmitted(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.terminalEmitted = false;
  }

  async markCanceled(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (r) r.canceled = true;
  }
}
