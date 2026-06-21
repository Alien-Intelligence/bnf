/**
 * BlobStore — durable object storage abstraction.
 *
 * Used by Track 1 to persist doc.md / doc.json / chunks.jsonl, and by Track 3
 * (or any retry path) to re-read them. Two implementations: `local.ts`
 * (filesystem) and `s3.ts` (Scaleway Object Storage / S3-compatible).
 */
export interface BlobStore {
  /** Idempotent put; overwrites if key exists. */
  put(key: string, body: Buffer | string, contentType?: string): Promise<void>;

  /** Returns the raw bytes, or null if the key does not exist. */
  get(key: string): Promise<Buffer | null>;

  /** Fast existence check (HEAD on S3, fs.stat locally). */
  exists(key: string): Promise<boolean>;

  /** Best-effort delete; returns true if removed, false if absent. */
  remove(key: string): Promise<boolean>;
}
