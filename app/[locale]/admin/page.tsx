// app/[locale]/admin/page.tsx
// /admin has no content of its own — it redirects to the Overview tab. The
// admin gate lives in the shared layout, so this only computes the target.

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
