import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireAdminUser } from "@/lib/auth-helpers"
import { ROUTES } from "@/lib/constants"
import { AdminUsageClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.usage")
  return { title: t("title") }
}

// Gated here, not only by the admin layout: a layout does not re-render on
// client navigation between tabs (Next 16, "Layouts and auth checks").
export default async function AdminUsagePage() {
  await requireAdminUser(ROUTES.adminUsage)
  return <AdminUsageClient />
}
