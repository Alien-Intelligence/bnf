/**
 * Public surface of Track 2. Other tracks should import from this file
 * (not from individual modules) so we can refactor internals freely.
 */

export { getBoss, stopBoss } from "./boss.js";
export { migrate, installSearchPath, SANDBOX_SCHEMA } from "./migrate.js";
export { Repo } from "./repo.js";
export {
  DocumentIngestRunner,
  type DatasetIdResolver,
  type OnDocTransition,
  type RunnerLogger,
} from "./runner.js";
export {
  emitProgressForIngestJob,
  isCanceled,
  markCanceled,
} from "./callback.js";
export {
  IngestOrchestrator,
  type IngestOrchestratorOptions,
  type SubmitInput,
  type SubmitResult,
} from "./orchestrator.js";
export {
  DOC_QUEUE_NAME,
  type DocJobQueuePayload,
  type DocumentIngestJobRow,
  type DocumentIngestJobStatus,
  type DocumentIngestStateRow,
  type DocumentIngestStateStatus,
  type IngestJobRow,
  type IngestJobStatus,
} from "./types.js";
