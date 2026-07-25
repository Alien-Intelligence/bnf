import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { AdminOverviewClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.overview")
  return { title: t("title") }
}

// Access is gated by app/[locale]/admin/layout.tsx (requireAdminUser). The
// report is fetched client-side; no server data is needed for SSR here.
export default function AdminOverviewPage() {
  return <AdminOverviewClient />
}
