import { Suspense } from "react"
import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { ssoEnabled } from "@/lib/env"
import { SignInClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signIn")
  return { title: t("title") }
}

export default function SignInPage() {
  // Computed server-side: the SSO button only renders when Alien Auth is
  // configured (lib/env.ssoEnabled). Passed as a plain boolean so the client
  // bundle never references the AUTHENTIK_* secrets.
  return (
    <Suspense>
      <SignInClient ssoEnabled={ssoEnabled} />
    </Suspense>
  )
}
