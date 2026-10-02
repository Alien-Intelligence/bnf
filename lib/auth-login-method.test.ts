// lib/auth-login-method.test.ts
// The endpoint path → login method resolver that the better-auth
// session.create hook uses to stamp `session.login_method`. It mirrors
// better-auth's own last-login-method resolver, restricted to the endpoints
// this app exposes; anything else is `null`, the defined legacy value.

import { test } from "node:test"
import assert from "node:assert/strict"

import { loginMethodFromAuthPath, loginMethodSchema } from "./auth-login-method"
import { LOGIN_METHOD, OAUTH_PROVIDER_ID } from "./constants"

test("a stored value outside LOGIN_METHOD is refused, not guessed", () => {
  assert.equal(loginMethodSchema.safeParse(LOGIN_METHOD.EMAIL).success, true)
  assert.equal(loginMethodSchema.safeParse(LOGIN_METHOD.AUTHENTIK).success, true)
  assert.equal(loginMethodSchema.safeParse("magic-link").success, false)
})

test("the Authentik OAuth callback → authentik", () => {
  assert.equal(
    loginMethodFromAuthPath(`/oauth2/callback/${OAUTH_PROVIDER_ID}`, OAUTH_PROVIDER_ID),
    LOGIN_METHOD.AUTHENTIK,
  )
})

test("another provider's callback → null (not a method this app knows)", () => {
  assert.equal(loginMethodFromAuthPath("/oauth2/callback/other", "other"), null)
})

test("email sign-in and sign-up → email", () => {
  assert.equal(loginMethodFromAuthPath("/sign-in/email", undefined), LOGIN_METHOD.EMAIL)
  assert.equal(loginMethodFromAuthPath("/sign-up/email", undefined), LOGIN_METHOD.EMAIL)
})

test("any other endpoint, or no context at all → null", () => {
  assert.equal(loginMethodFromAuthPath("/change-password", undefined), null)
  assert.equal(loginMethodFromAuthPath(undefined, undefined), null)
})
