import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireAdminUser } from "@/lib/auth-helpers"
import { ROUTES } from "@/lib/constants"
import { AdminAccountsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.accounts")
  return { title: t("title") }
}

// Gated here, not only by the admin layout: a layout does not re-render on
// client navigation between tabs (Next 16, "Layouts and auth checks").
export default async function AdminAccountsPage() {
  await requireAdminUser(ROUTES.adminAccounts)
  return <AdminAccountsClient />
}
