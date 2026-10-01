// app/[locale]/page.tsx
// The locale root. It owns one decision: a signed-in visitor goes to their
// projects, everyone else to sign-in — both in the visitor's locale. Before
// this it always redirected to the French sign-in page, so a signed-in user
// opening `/` saw the login form (feedback #4).

import { redirect } from "@/i18n/navigation"
import { findSessionUser } from "@/lib/auth-helpers"
import { ROUTES } from "@/lib/constants"

export default async function RootPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const user = await findSessionUser()
  redirect({ href: user ? ROUTES.projects : ROUTES.signIn, locale })
}
