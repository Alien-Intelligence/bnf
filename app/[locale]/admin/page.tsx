// app/[locale]/admin/page.tsx
// /admin has no content of its own — it redirects to the Overview tab, whose
// page runs the admin check (every tab gates itself; the layout never does).

import { redirect } from "@/i18n/navigation"
import { ROUTES } from "@/lib/constants"

export default async function AdminIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  redirect({ href: ROUTES.adminOverview, locale })
}
