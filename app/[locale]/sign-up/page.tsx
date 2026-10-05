// app/[locale]/sign-up/page.tsx
// A signed-in visitor has no account to create: send them to their projects
// in their locale instead of showing the form.

import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { redirect } from "@/i18n/navigation"
import { findSessionUser } from "@/lib/auth-helpers"
import { ROUTES } from "@/lib/constants"
import { SignUpClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signUp")
  return { title: t("title") }
}

export default async function SignUpPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const user = await findSessionUser()
  if (user) redirect({ href: ROUTES.projects, locale })

  return <SignUpClient />
}
