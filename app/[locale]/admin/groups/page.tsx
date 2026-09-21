import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { GroupQueries } from "@/models/groups/queries"
import { AdminGroupsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("groups")
  return { title: t("title") }
}

// Access is gated by app/[locale]/admin/layout.tsx (requireAdminUser).
export default async function AdminGroupsPage() {
  // Seeding the list server-side means the admin lands on the table itself
  // rather than on a skeleton the client would have to fetch its way out of.
  const groups = await GroupQueries.list()

  return <AdminGroupsClient initialGroups={groups} />
}
