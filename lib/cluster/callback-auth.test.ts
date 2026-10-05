// lib/cluster/callback-auth.test.ts
// The progress callback's verification (found in the Track B pass-2 review):
// an unknown job, a job without a secret and a bad signature are ONE answer,
// and the HMAC runs in every case — the endpoint is no oracle for job ids.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"

import { POST } from "@/app/api/internal/ingest/[job_id]/progress/route"
import { PROGRESS_CALLBACK_BODY_READ_MS, PROGRESS_CALLBACK_MAX_BODY_BYTES } from "@/lib/constants"
import { prisma } from "@/lib/db"
import { createTestProject, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { INGEST_STATUS } from "@/models/ingest/schema"

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

/** A real ingest job with a known callback secret, torn down by the caller. */
async function knownJob(): Promise<{ jobId: string; secret: string; cleanup: () => Promise<void> }> {
  const user = await createTestUser()
  const project = await createTestProject(user.id, "progress-cap")
  if (project.headVersionId === null) throw new Error("fixture project has no head version")
  const secret = "s".repeat(64)
  const job = await prisma.ingestJob.create({
    data: {
      projectId: project.id,
      targetVersionId: project.headVersionId,
      status: INGEST_STATUS.RUNNING,
      callbackSecret: secret,
    },
  })
  return {
    jobId: job.id,
    secret,
    cleanup: async () => {
      await prisma.ingestJob.deleteMany({ where: { id: job.id } })
      await cleanupProject(project.id)
      await deleteTestUser(user.id)
    },
  }
}

test("progress route: an oversize body with a VALID signature for a KNOWN job is still refused, uniformly", async () => {
  const job = await knownJob()
  try {
    // A well-formed running event padded past the cap and correctly signed:
    // without the cap this would be applied (200).
    const body = JSON.stringify({
      stage: "extract",
      fraction: 0.5,
      counters: { n: 1 },
      padding: "x".repeat(PROGRESS_CALLBACK_MAX_BODY_BYTES),
    })
    const req = new Request(`http://localhost/api/internal/ingest/${job.jobId}/progress`, {
      method: "POST",
      headers: { "x-callback-signature": signCallback(body, job.secret) },
      body,
    })
    const res = await POST(req, { params: Promise.resolve({ job_id: job.jobId }) })
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: CALLBACK_REJECTED_MESSAGE })
    // The same event under the cap is accepted — the refusal was the size.
    const small = JSON.stringify({ stage: "extract", fraction: 0.5, counters: { n: 1 } })
    const ok = await POST(
      new Request(`http://localhost/api/internal/ingest/${job.jobId}/progress`, {
        method: "POST",
        headers: { "x-callback-signature": signCallback(small, job.secret) },
        body: small,
      }),
      { params: Promise.resolve({ job_id: job.jobId }) },
    )
    assert.equal(ok.status, 200)
  } finally {
    await job.cleanup()
  }
})

test("progress route: a body that never finishes arriving is cut off at the read deadline", { timeout: PROGRESS_CALLBACK_BODY_READ_MS + 10_000 }, async () => {
  const job = await knownJob()
  try {
    const trickle = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"stage":'))
        // …and nothing more, ever.
      },
    })
    // Node needs `duplex: "half"` for a streamed request body; the DOM
    // RequestInit type does not declare it.
    const init: RequestInit & { duplex: "half" } = { method: "POST", body: trickle, duplex: "half" }
    const req = new Request(`http://localhost/api/internal/ingest/${job.jobId}/progress`, init)
    const started = Date.now()
    const res = await POST(req, { params: Promise.resolve({ job_id: job.jobId }) })
    assert.equal(res.status, 401)
    assert.ok(Date.now() - started < PROGRESS_CALLBACK_BODY_READ_MS + 5_000)
  } finally {
    await job.cleanup()
  }
})
