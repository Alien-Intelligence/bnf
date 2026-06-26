/**
 * Blob store — the durable artifact layer + idempotency primitive.
 *
 * Every external-call result is persisted here keyed deterministically; the queue
 * only carries pointers. `has(key)` answering true means "this work already
 * happened" → the stage base skips the external call and resumes (see core/stage.ts).
 *
 * Two implementations behind one interface:
 *  - MemoryBlobStore: unit tests (no infra).
 *  - S3BlobStore: Scaleway Object Storage (prod), lazily constructed.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { BlobStore } from "./types.js";

export class MemoryBlobStore implements BlobStore {
  private readonly store = new Map<string, Buffer>();

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async getBytes(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }
  async getJson<T>(key: string): Promise<T | null> {
    const b = this.store.get(key);
    return b ? (JSON.parse(b.toString("utf8")) as T) : null;
  }
  async putBytes(key: string, bytes: Buffer): Promise<void> {
    this.store.set(key, bytes);
  }
  async putJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, Buffer.from(JSON.stringify(value), "utf8"));
  }
  /** Test helper. */
  size(): number {
    return this.store.size;
  }
}

export interface S3BlobStoreOpts {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional key namespace, e.g. a per-project prefix. */
  prefix?: string;
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3BlobStoreOpts) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ? opts.prefix.replace(/\/$/, "") + "/" : "";
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      forcePathStyle: true,
    });
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async getBytes(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }),
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const b = await this.getBytes(key);
    return b ? (JSON.parse(b.toString("utf8")) as T) : null;
  }

  async putBytes(key: string, bytes: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.putBytes(key, Buffer.from(JSON.stringify(value), "utf8"), "application/json");
  }
}

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}
