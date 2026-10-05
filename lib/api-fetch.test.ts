// lib/api-fetch.test.ts
// A read the server REFUSES (4xx) reaches the page with the server's message
// and is never retried; any other failure stays a plain, retriable error.
import { test } from "node:test"
import assert from "node:assert/strict"
import { RequestRefusedError, readQueryError, retryUnlessRefused } from "./api-fetch"

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("a 400 becomes a RequestRefusedError carrying the server's message", async () => {
  const err = await readQueryError(json(400, { error: "Langue(s) absente(s) du corpus : xx." }), "Failed to fetch corpus")
  assert.ok(err instanceof RequestRefusedError)
  assert.equal(err.message, "Langue(s) absente(s) du corpus : xx.")
  assert.equal(retryUnlessRefused(0, err), false, "a refusal is never retried")
})

test("a 500 stays a plain error, retried like any other failure", async () => {
  const err = await readQueryError(json(500, { error: "boom" }), "Failed to fetch corpus")
  assert.ok(!(err instanceof RequestRefusedError))
  assert.equal(retryUnlessRefused(0, err), true)
  assert.equal(retryUnlessRefused(3, err), false, "bounded like the default")
})
