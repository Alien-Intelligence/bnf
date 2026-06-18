import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { SignUpClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.signUp")
  return { title: t("title") }
}

export default function SignUpPage() {
  return <SignUpClient />
}
