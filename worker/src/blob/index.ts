import { blob } from "../env.js";
import type { BlobStore } from "./interface.js";
import { LocalFsBlobStore } from "./local.js";
import { S3BlobStore } from "./s3.js";

let cached: BlobStore | null = null;

/** Process-wide BlobStore selected by BLOB_STORE env. */
export function getBlobStore(): BlobStore {
  if (cached) return cached;
  if (blob.driver() === "local") {
    cached = new LocalFsBlobStore(blob.localRoot());
  } else {
    cached = new S3BlobStore({
      bucket: blob.s3.bucket(),
      region: blob.s3.region(),
      endpoint: blob.s3.endpoint(),
      accessKey: blob.s3.accessKey(),
      secretKey: blob.s3.secretKey(),
    });
  }
  return cached;
}

export type { BlobStore } from "./interface.js";
export { LocalFsBlobStore } from "./local.js";
export { S3BlobStore } from "./s3.js";
