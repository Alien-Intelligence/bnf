// Scrub truncated JPEGs (no EOI in trailing 32B) from v2/image/ — cache
// entries only, re-fetched on demand; the deployed fetch stage also
// self-repairs on contact, so this is belt-and-suspenders for retry latency.
// Runs LOCALLY (S3 endpoint is public) with bounded concurrency — the two
// in-pod attempts died sharing the prod worker's memory cgroup.
import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.SCW_S3_ENDPOINT_URL,
  region: process.env.SCW_S3_REGION,
  credentials: {
    accessKeyId: process.env.SCW_S3_ACCESS_KEY,
    secretAccessKey: process.env.SCW_S3_SECRET_KEY,
  },
  forcePathStyle: true,
});
const B = process.env.SCW_S3_BUCKET;
const CONCURRENCY = 16;

let scanned = 0, deleted = 0;
const deletedKeys = [];

async function checkOne(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: B, Key: key, Range: "bytes=-32" }));
  const tail = Buffer.from(await r.Body.transformToByteArray());
  scanned++;
  if (!tail.includes(Buffer.from([0xff, 0xd9]))) {
    await s3.send(new DeleteObjectCommand({ Bucket: B, Key: key }));
    deleted++;
    deletedKeys.push(key);
  }
}

let token;
do {
  const page = await s3.send(new ListObjectsV2Command({ Bucket: B, Prefix: "v2/image/", ContinuationToken: token }));
  const keys = (page.Contents ?? []).map((o) => o.Key);
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    await Promise.all(keys.slice(i, i + CONCURRENCY).map(checkOne));
  }
  if (scanned % 5000 < 1000) console.log(`progress: scanned=${scanned} deleted=${deleted}`);
  token = page.NextContinuationToken;
} while (token);

console.log(JSON.stringify({ scanned, deleted }));
for (const k of deletedKeys) console.log("deleted:", k);
