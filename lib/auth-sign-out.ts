import "server-only"

// lib/auth-sign-out.ts
// The locale-aware half of sign-out's redirect: the in-app sign-in path that
// says how the session ended. Kept out of the users service (a service builds
// no page URLs) and out of lib/auth-redirect.ts (which stays importable under
// `node --test`, where @/i18n/navigation cannot load).

import { getPathname } from "@/i18n/navigation"
import { AUTH_QUERY, ROUTES } from "@/lib/constants"
import type { SignedOutNotice } from "@/lib/auth-redirect"
import type { AppLocale } from "@/i18n/routing"

/** "/sign-in?signedOut=done", or "/en/sign-in?signedOut=done" for English. */
export function signedOutPath(notice: SignedOutNotice, locale: AppLocale): string {
  return getPathname({
    href: { pathname: ROUTES.signIn, query: { [AUTH_QUERY.SIGNED_OUT]: notice } },
    locale,
  })
}
