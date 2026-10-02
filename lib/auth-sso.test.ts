// lib/auth-sso.test.ts
// The SSO half of sign-out: whether to end the Authentik session, the
// RP-initiated logout URL, and the discovery fetch (bounded, strict, memoized
// on success only). No network: `fetchImpl` is injected.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  OidcDiscoveryError,
  authentikDiscoveryUrl,
  endSessionUrl,
  loadAuthentikDiscovery,
  shouldEndSsoSession,
  signOutRedirect,
  type OidcDiscovery,
} from "./auth-sso"
import { LOGIN_METHOD, SIGNED_OUT_NOTICE, SSO_LOGOUT } from "@/models/users/schema"

const cfg = {
  baseUrl: "https://auth.example",
  appSlug: "datastreaming",
  clientId: "client-123",
  clientSecret: "shh",
}

const discovery: OidcDiscovery = {
  issuer: "https://auth.example/application/o/datastreaming/",
  end_session_endpoint: "https://auth.example/application/o/datastreaming/end-session/",
}

// --- the decision -----------------------------------------------------------

test("SSO not configured → never, whatever the session says", () => {
  for (const loginMethod of [LOGIN_METHOD.AUTHENTIK, LOGIN_METHOD.EMAIL, null]) {
    for (const hasAuthentikAccount of [true, false]) {
      assert.equal(
        shouldEndSsoSession({ ssoConfigured: false, loginMethod, hasAuthentikAccount }),
        false,
        `${loginMethod} / account=${hasAuthentikAccount}`,
      )
    }
  }
})

test("a session opened through Authentik → yes", () => {
  assert.equal(shouldEndSsoSession({ ssoConfigured: true, loginMethod: LOGIN_METHOD.AUTHENTIK, hasAuthentikAccount: true }), true)
  // The account row is not the deciding fact when the method is known.
  assert.equal(shouldEndSsoSession({ ssoConfigured: true, loginMethod: LOGIN_METHOD.AUTHENTIK, hasAuthentikAccount: false }), true)
})

test("a session opened with email/password → no, even for a linked account", () => {
  assert.equal(shouldEndSsoSession({ ssoConfigured: true, loginMethod: LOGIN_METHOD.EMAIL, hasAuthentikAccount: true }), false)
  assert.equal(shouldEndSsoSession({ ssoConfigured: true, loginMethod: LOGIN_METHOD.EMAIL, hasAuthentikAccount: false }), false)
})

test("a legacy session (null) → end the SSO session iff the user has an Authentik account", () => {
  assert.equal(shouldEndSsoSession({ ssoConfigured: true, loginMethod: null, hasAuthentikAccount: true }), true)
  assert.equal(shouldEndSsoSession({ ssoConfigured: true, loginMethod: null, hasAuthentikAccount: false }), false)
})

// --- the URLs ---------------------------------------------------------------

test("discovery URL is the application's well-known document", () => {
  assert.equal(
    authentikDiscoveryUrl(cfg),
    "https://auth.example/application/o/datastreaming/.well-known/openid-configuration",
  )
})

test("end-session URL carries id_token_hint, client_id and post_logout_redirect_uri", () => {
  const url = endSessionUrl(discovery, {
    idTokenHint: "eyJ.id.token",
    clientId: cfg.clientId,
    postLogoutRedirectUri: "https://bnf.example/sign-in?signedOut=done",
  })
  assert.equal(
    url,
    "https://auth.example/application/o/datastreaming/end-session/?id_token_hint=eyJ.id.token&client_id=client-123&post_logout_redirect_uri=https%3A%2F%2Fbnf.example%2Fsign-in%3FsignedOut%3Ddone",
  )
})

test("end-session URL omits id_token_hint when there is none", () => {
  const url = new URL(
    endSessionUrl(discovery, { idTokenHint: null, clientId: cfg.clientId, postLogoutRedirectUri: "https://bnf.example/sign-in" }),
  )
  assert.equal(url.searchParams.has("id_token_hint"), false)
  assert.equal(url.searchParams.get("client_id"), cfg.clientId)
})

// --- the fetch --------------------------------------------------------------

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

function fetchStub(responses: Array<() => Response>): { impl: FetchImpl; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error("fetchStub: no response left")
    return next()
  }
  return { impl, calls }
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("a non-OK discovery response rejects with the status, and is not memoized", async () => {
  const stub = fetchStub([json({ error: "down" }, 500), json(discovery)])
  const key = { ...cfg, appSlug: "non-ok" }
  await assert.rejects(
    loadAuthentikDiscovery(key, stub.impl),
    (e: unknown) => e instanceof OidcDiscoveryError && /500/.test(e.message),
  )
  const second = await loadAuthentikDiscovery(key, stub.impl)
  assert.equal(second.end_session_endpoint, discovery.end_session_endpoint)
  assert.equal(stub.calls.length, 2, "the rejection must not be cached")
})

test("a document without end_session_endpoint is a parse error, never a guessed path", async () => {
  const stub = fetchStub([json({ issuer: discovery.issuer })])
  await assert.rejects(
    loadAuthentikDiscovery({ ...cfg, appSlug: "no-end-session" }, stub.impl),
    OidcDiscoveryError,
  )
})

test("a successful discovery is memoized for the process", async () => {
  const stub = fetchStub([json(discovery)])
  const key = { ...cfg, appSlug: "memo" }
  const a = await loadAuthentikDiscovery(key, stub.impl)
  const b = await loadAuthentikDiscovery(key, stub.impl)
  assert.deepEqual(a, b)
  assert.equal(stub.calls.length, 1)
})

test("the fetch is bounded by an AbortSignal", async () => {
  const stub = fetchStub([json(discovery)])
  await loadAuthentikDiscovery({ ...cfg, appSlug: "signal" }, stub.impl)
  assert.ok(stub.calls[0]?.init?.signal instanceof AbortSignal)
})

test("a network failure or timeout is an OidcDiscoveryError carrying the cause", async () => {
  const cause = new DOMException("The operation was aborted due to timeout", "TimeoutError")
  const impl: FetchImpl = async () => {
    throw cause
  }
  await assert.rejects(
    loadAuthentikDiscovery({ ...cfg, appSlug: "timeout" }, impl),
    (e: unknown) => e instanceof OidcDiscoveryError && e.cause === cause,
  )
})

test("a non-JSON body is an OidcDiscoveryError", async () => {
  const impl: FetchImpl = async () => new Response("<html>proxy</html>", { status: 200 })
  await assert.rejects(loadAuthentikDiscovery({ ...cfg, appSlug: "html" }, impl), OidcDiscoveryError)
})

// --- where the browser goes -------------------------------------------------

const signedOutPath = (notice: string) => `/en/sign-in?signedOut=${notice}`
const ctx = { signedOutPath, appUrl: "https://bnf.example" }

test("no SSO hop → the signed-out sign-in page", () => {
  assert.equal(
    signOutRedirect({ ssoLogout: SSO_LOGOUT.NOT_APPLICABLE }, ctx),
    `/en/sign-in?signedOut=${SIGNED_OUT_NOTICE.DONE}`,
  )
})

test("discovery unavailable → the sign-in page that says the Alien session stayed open", () => {
  assert.equal(
    signOutRedirect({ ssoLogout: SSO_LOGOUT.UNAVAILABLE }, ctx),
    `/en/sign-in?signedOut=${SIGNED_OUT_NOTICE.SSO_UNAVAILABLE}`,
  )
})

test("SSO hop → Authentik's end-session URL, coming back to the absolute signed-out page", () => {
  const url = new URL(
    signOutRedirect(
      { ssoLogout: SSO_LOGOUT.INITIATED, discovery, idTokenHint: "eyJ.id", clientId: cfg.clientId },
      ctx,
    ),
  )
  assert.equal(`${url.origin}${url.pathname}`, discovery.end_session_endpoint)
  assert.equal(url.searchParams.get("id_token_hint"), "eyJ.id")
  assert.equal(
    url.searchParams.get("post_logout_redirect_uri"),
    `https://bnf.example/en/sign-in?signedOut=${SIGNED_OUT_NOTICE.DONE}`,
  )
})
