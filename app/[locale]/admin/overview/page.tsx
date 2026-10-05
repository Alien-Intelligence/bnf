import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireAdminUser } from "@/lib/auth-helpers"
import { ROUTES } from "@/lib/constants"
import { AdminOverviewClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.overview")
  return { title: t("title") }
}

// Gated here, not only by the admin layout: a layout does not re-render on
// client navigation between tabs (Next 16, "Layouts and auth checks").
// The report is fetched client-side; no server data is needed for SSR here.
export default async function AdminOverviewPage() {
  await requireAdminUser(ROUTES.adminOverview)
  return <AdminOverviewClient />
}
