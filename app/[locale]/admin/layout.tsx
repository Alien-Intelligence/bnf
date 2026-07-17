// app/[locale]/admin/layout.tsx
// Admin console shell — shared by every admin tab (overview, accounts,
// feedback, usage). Owns the single access gate (requireAdminUser), the
// co-branded header, the tab-nav, and the centred main column, so each tab's
// client renders only its own content. A non-admin hits notFound() here (404,
// not a visible 403) before any tab code runs.

import type { ReactNode } from "react"
import { requireAdminUser } from "@/lib/auth-helpers"
import { WorkspaceHeader } from "@/components/layouts/workspace/header"
import { LayoutAdminTabs } from "@/components/layouts/admin/tabs"

export default async function AdminLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireAdminUser("/admin")

  return (
    <div className="flex min-h-screen flex-col">
      <WorkspaceHeader
        user={{ name: user.name, email: user.email }}
        isAdmin
      />
      <LayoutAdminTabs />
      <main className="mx-auto w-full max-w-5xl px-6 py-12">{children}</main>
    </div>
  )
}
