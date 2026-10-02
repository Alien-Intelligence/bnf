// lib/auth-redirect.ts
// The ONE function that turns an untrusted `?next=` into a navigation target.
//
// Contract: whatever the input, the output is an app-relative path the i18n
// router can prefix with the current locale. Anything else → ROUTES.projects.
// Before this existed the sign-in client did `router.push(next)` on the raw
// query value, so `?next=https://evil.example` sent a freshly signed-in user
// off-site (an open redirect).
//
// It also reads the `?signedOut=` notice and renders locale-prefixed paths for
// code that cannot load next-intl's navigation (scripts, node tests).
//
// No `server-only`: the sign-in page (server) and the sign-in client both use
// it, and it is pure. It imports `@/i18n/routing` (the locale list), never
// `@/i18n/navigation`, so it also runs under `node --test`.

import { routing, type AppLocale } from "@/i18n/routing"
import { ROUTES, SAFE_NEXT_MAX_LENGTH } from "@/lib/constants"
import { signedOutNoticeSchema, type SignedOutNotice } from "@/models/users/types"

// A base that can never match a real origin, so "did parsing keep us on it?"
// is the same-origin test.
const PLACEHOLDER_ORIGIN = "http://next.invalid"

// Never a post-auth destination: API responses are not pages, and the auth
// pages would bounce a signed-in user straight back (a redirect loop).
const REFUSED_PATHS = ["/api", ROUTES.signIn, ROUTES.signUp] as const

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function safeNextPath(raw: string | null): string {
  if (raw === null || raw.length === 0 || raw.length > SAFE_NEXT_MAX_LENGTH) {
    return ROUTES.projects
  }
  // One leading slash, no scheme, no authority ("//host"), no backslash
  // (browsers normalise "/\host" to "//host"), no control characters.
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    CONTROL_CHARS.test(raw)
  ) {
    return ROUTES.projects
  }
  // Cannot throw for a "/…" string against an absolute base.
  const url = new URL(raw, PLACEHOLDER_ORIGIN)
  if (url.origin !== PLACEHOLDER_ORIGIN) return ROUTES.projects

  const path = stripLocalePrefix(url.pathname)
  if (
    path === "/" ||
    REFUSED_PATHS.some((p) => path === p || path.startsWith(`${p}/`))
  ) {
    return ROUTES.projects
  }
  return `${path}${url.search}${url.hash}`
}

/**
 * "/en/projects" → "/projects". The caller's locale decides the prefix, never
 * the query: a French user following an `/en/…` link stays in French.
 */
function stripLocalePrefix(pathname: string): string {
  for (const locale of routing.locales) {
    if (pathname === `/${locale}`) return "/"
    if (pathname.startsWith(`/${locale}/`)) return pathname.slice(locale.length + 1)
  }
  return pathname
}

/**
 * Next hands a repeated query key as `string[]`. A repeated `next` is refused
 * rather than guessed: there is no right answer to "which one did you mean?".
 */
export function singleSearchParam(
  value: string | string[] | undefined,
): string | null {
  return typeof value === "string" ? value : null
}

/**
 * The notice the sign-in page shows for a `?signedOut=` value, or null when
 * there is none. An unknown value renders no notice rather than a wrong one.
 */
export function signedOutNotice(raw: string | null): SignedOutNotice | null {
  const parsed = signedOutNoticeSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * The browser path of an in-app path in a locale, as next-intl's
 * `localePrefix: "as-needed"` routing renders it: the default locale has no
 * prefix, every other locale does. Pure, so scripts and node tests can build
 * the same URLs the app's getPathname does (they cannot import
 * @/i18n/navigation, which needs the React client runtime).
 */
export function localePrefixedPath(path: string, locale: AppLocale): string {
  if (locale === routing.defaultLocale) return path
  return path === "/" ? `/${locale}` : `/${locale}${path}`
}
