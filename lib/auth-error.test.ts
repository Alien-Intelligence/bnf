// lib/auth-error.test.ts
// Reading better-auth's refusal on the auth forms: a code when there is one,
// null (reported) when the body is not JSON or has no code.

import { test } from "node:test"
import assert from "node:assert/strict"

import { EMAIL_TAKEN_CODES, INVALID_CREDENTIAL_CODES, betterAuthErrorCode } from "./auth-error"
import { BETTER_AUTH_ERROR } from "./constants"

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("a better-auth refusal yields its code", async () => {
  assert.equal(
    await betterAuthErrorCode(json({ code: BETTER_AUTH_ERROR.INVALID_EMAIL_OR_PASSWORD, message: "x" }, 401)),
    BETTER_AUTH_ERROR.INVALID_EMAIL_OR_PASSWORD,
  )
})

test("a non-JSON body or a body without a code yields null", async () => {
  assert.equal(await betterAuthErrorCode(new Response("<html>502</html>", { status: 502 })), null)
  assert.equal(await betterAuthErrorCode(json({ error: "Internal" }, 500)), null)
})

test("the two families the forms explain", () => {
  assert.ok(INVALID_CREDENTIAL_CODES.has(BETTER_AUTH_ERROR.USER_NOT_FOUND))
  assert.ok(EMAIL_TAKEN_CODES.has(BETTER_AUTH_ERROR.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL))
  assert.ok(!INVALID_CREDENTIAL_CODES.has(BETTER_AUTH_ERROR.USER_ALREADY_EXISTS))
})
