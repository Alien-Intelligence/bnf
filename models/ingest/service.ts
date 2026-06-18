import "server-only"
import type { IngestJob } from "./schema"

export class IngestService {
  /**
   * Stub — implemented in slice 4. Signature locked now so that
   * playbook/corpus-versioning.md invariant 4 holds at the type level:
   * project.ingestedVersionId is ONLY moved by IngestService.commit().
   */
  static async commit(_job: IngestJob, _results: unknown): Promise<void> {
    throw new Error("IngestService.commit not implemented — lands in slice 4")
  }
}
