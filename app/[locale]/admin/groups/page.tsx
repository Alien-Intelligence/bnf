import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { AdminGroupsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("groups")
  return { title: t("title") }
}

// Access is gated by app/[locale]/admin/layout.tsx (requireAdminUser).
export default function AdminGroupsPage() {
  return <AdminGroupsClient />
}
