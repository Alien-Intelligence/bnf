import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { AdminAccountsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.accounts")
  return { title: t("title") }
}

// Access is gated by app/[locale]/admin/layout.tsx (requireAdminUser).
export default function AdminAccountsPage() {
  return <AdminAccountsClient />
}
