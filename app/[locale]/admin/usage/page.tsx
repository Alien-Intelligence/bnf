import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { AdminUsageClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.usage")
  return { title: t("title") }
}

// Access is gated by app/[locale]/admin/layout.tsx (requireAdminUser).
export default function AdminUsagePage() {
  return <AdminUsageClient />
}
