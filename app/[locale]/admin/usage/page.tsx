import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireAdminUser } from "@/lib/auth-helpers"
import { AdminUsageClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.usage")
  return { title: t("title") }
}

export default async function AdminUsagePage() {
  await requireAdminUser("/admin/usage")
  return <AdminUsageClient />
}
