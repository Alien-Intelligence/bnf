// lib/cluster/callback-auth.test.ts
// The progress callback's verification (found in the Track B pass-2 review):
// an unknown job, a job without a secret and a bad signature are ONE answer,
// and the HMAC runs in every case — the endpoint is no oracle for job ids.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { POST } from "@/app/api/internal/ingest/[job_id]/progress/route"
import { PROGRESS_CALLBACK_MAX_BODY_BYTES } from "@/lib/constants"

import { CALLBACK_REJECTED_MESSAGE, signCallback, verifyCallback, verifyJobCallback } from "./callback-auth"

const SECRET = "a".repeat(64)
const BODY = '{"stage":"done"}'

test("verifyCallback: the right signature passes; wrong, absent or malformed ones fail", () => {
  assert.equal(verifyCallback(BODY, signCallback(BODY, SECRET), SECRET), true)
  assert.equal(verifyCallback(BODY, signCallback(BODY, "b".repeat(64)), SECRET), false)
  assert.equal(verifyCallback(BODY, null, SECRET), false)
  assert.equal(verifyCallback(BODY, "sha256=short", SECRET), false)
})

test("verifyJobCallback: no secret (unknown job, blank secret) is rejected even with a 'valid' signature", () => {
  // A signature made with an empty secret must not open a job that has none.
  assert.equal(verifyJobCallback(BODY, signCallback(BODY, ""), null), false)
  assert.equal(verifyJobCallback(BODY, signCallback(BODY, ""), ""), false)
  assert.equal(verifyJobCallback(BODY, signCallback(BODY, SECRET), SECRET), true)
})

test("progress route: an unknown job reads the body and answers the bad-signature 401", async () => {
  const req = new Request("http://localhost/api/internal/ingest/x/progress", {
    method: "POST",
    headers: { "x-callback-signature": signCallback(BODY, SECRET) },
    body: BODY,
  })
  const res = await POST(req, {
    params: Promise.resolve({ job_id: "00000000-0000-4000-8000-00000000dead" }),
  })
  assert.equal(res.status, 401)
  assert.equal(req.bodyUsed, true, "the body is read on the unknown-job path too")
  assert.deepEqual(await res.json(), { error: CALLBACK_REJECTED_MESSAGE })
})

test("progress route: an oversize body is refused with the same answer, before it is read", async () => {
  const big = "x".repeat(PROGRESS_CALLBACK_MAX_BODY_BYTES + 1)
  for (const req of [
    new Request("http://localhost/api/internal/ingest/x/progress", { method: "POST", body: big }),
    new Request("http://localhost/api/internal/ingest/x/progress", {
      method: "POST",
      headers: { "content-length": String(PROGRESS_CALLBACK_MAX_BODY_BYTES + 1) },
      body: "{}",
    }),
  ]) {
    const res = await POST(req, { params: Promise.resolve({ job_id: "00000000-0000-4000-8000-00000000dead" }) })
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: CALLBACK_REJECTED_MESSAGE })
  }
})
