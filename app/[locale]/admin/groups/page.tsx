import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { requireAdminUser } from "@/lib/auth-helpers"
import { ROUTES } from "@/lib/constants"
import { GroupQueries } from "@/models/groups/queries"
import { AdminGroupsClient } from "./client"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("groups")
  return { title: t("title") }
}

// Gated here, not only by the admin layout: a layout does not re-render on
// client navigation between tabs (Next 16, "Layouts and auth checks").
export default async function AdminGroupsPage() {
  await requireAdminUser(ROUTES.adminGroups)
  // Seeding the list server-side means the admin lands on the table itself
  // rather than on a skeleton the client would have to fetch its way out of.
  const groups = await GroupQueries.list()

  return <AdminGroupsClient initialGroups={groups} />
}
