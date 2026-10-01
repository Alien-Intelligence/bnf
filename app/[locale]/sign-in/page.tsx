// app/[locale]/sign-in/page.tsx
// Server half of sign-in. Reads the session: a signed-in visitor never sees
// the form and is sent to a SAFE `next` (or the projects list). The raw
// `?next=` is validated here, once, and handed to the client as a prop, so the
// client never reads the query string itself (no `useSearchParams`, no
// Suspense boundary, and no second place that could trust the raw value).

import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { redirect } from "@/i18n/navigation"
import { findSessionUser } from "@/lib/auth-helpers"
import { safeNextPath, singleSearchParam } from "@/lib/auth-redirect"
import { AUTH_QUERY } from "@/lib/constants"
import { ssoEnabled } from "@/lib/env"
import { SignInClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signIn")
  return { title: t("title") }
}

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const nextPath = safeNextPath(singleSearchParam(query[AUTH_QUERY.NEXT]))

  const user = await findSessionUser()
  if (user) redirect({ href: nextPath, locale })

  // Computed server-side: the SSO button only renders when Alien Auth is
  // configured (lib/env.ssoEnabled). Passed as a plain boolean so the client
  // bundle never references the AUTHENTIK_* secrets.
  return <SignInClient ssoEnabled={ssoEnabled} nextPath={nextPath} />
}
