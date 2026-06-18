import { Suspense } from "react"
import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { SignInClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signIn")
  return { title: t("title") }
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInClient />
    </Suspense>
  )
}
