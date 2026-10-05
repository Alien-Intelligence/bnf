// lib/auth-redirect.test.ts
// The one function that turns an untrusted `?next=` into a navigation target.
// Before this module existed, sign-in did `router.push(next)` on the raw query
// value — an open redirect. Every row here is a way that trust was abusable.

import { test } from "node:test"
import assert from "node:assert/strict"

import { localePrefixedPath, safeNextPath, signedOutNotice, singleSearchParam } from "./auth-redirect"
import { ROUTES, SAFE_NEXT_MAX_LENGTH } from "./constants"
import { routing } from "@/i18n/routing"
import { SIGNED_OUT_NOTICE } from "@/models/users/schema"

test("absent or empty → the projects list", () => {
  assert.equal(safeNextPath(null), ROUTES.projects)
  assert.equal(safeNextPath(""), ROUTES.projects)
})

test("an in-app path keeps its query and hash", () => {
  const next = "/projects/abc/rechercher?tab=notes#n1"
  assert.equal(safeNextPath(next), next)
})

test("anything that could leave the app → the projects list", () => {
  const hostile = [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/x",
    "javascript:alert(1)",
    "projects",
    "/a\u0000b",
    `/${"a".repeat(SAFE_NEXT_MAX_LENGTH)}`,
  ]
  for (const raw of hostile) {
    assert.equal(safeNextPath(raw), ROUTES.projects, JSON.stringify(raw))
  }
})

test("API responses and the auth pages are never a destination", () => {
  for (const raw of ["/api/projects", "/sign-in", "/sign-in?next=/x", "/sign-up", "/"]) {
    assert.equal(safeNextPath(raw), ROUTES.projects, raw)
  }
})

test("a locale prefix is stripped: the caller's locale decides, not the query", () => {
  assert.equal(safeNextPath("/en/projects/abc/ingerer"), "/projects/abc/ingerer")
  assert.equal(safeNextPath("/fr"), ROUTES.projects)
  assert.equal(safeNextPath("/en"), ROUTES.projects)
})

test("a path that merely starts with a locale's letters is not a locale prefix", () => {
  assert.equal(safeNextPath("/english/x"), "/english/x")
})

test("a repeated query key is refused, not guessed", () => {
  assert.equal(singleSearchParam(["/a", "/b"]), null)
  assert.equal(singleSearchParam(undefined), null)
  assert.equal(singleSearchParam("/a"), "/a")
})

test("signedOutNotice: a known value is the notice, anything else is none", () => {
  assert.equal(signedOutNotice(SIGNED_OUT_NOTICE.DONE), SIGNED_OUT_NOTICE.DONE)
  assert.equal(signedOutNotice(SIGNED_OUT_NOTICE.SSO_UNAVAILABLE), SIGNED_OUT_NOTICE.SSO_UNAVAILABLE)
  assert.equal(signedOutNotice("pwned"), null)
  assert.equal(signedOutNotice(null), null)
})

test("localePrefixedPath: no prefix for the default locale, a prefix otherwise", () => {
  assert.equal(localePrefixedPath(ROUTES.projects, routing.defaultLocale), ROUTES.projects)
  for (const locale of routing.locales.filter((l) => l !== routing.defaultLocale)) {
    assert.equal(localePrefixedPath(ROUTES.projects, locale), `/${locale}${ROUTES.projects}`)
    assert.equal(localePrefixedPath("/", locale), `/${locale}`)
  }
})
