// app/[locale]/admin/layout.tsx
// Admin console shell — shared by every admin tab (overview, accounts,
// feedback, usage, …). Owns the co-branded header, the tab-nav and the centred
// main column, so each tab's client renders only its own content. It resolves
// the admin for the header with requireAdminUser, but it is not the gate: a
// layout does not re-render on client navigation between tabs (Next 16,
// "Layouts and auth checks"), so every tab page runs its own
// requireAdminUser(<its ROUTES path>). A non-admin gets notFound() (404, not
// a visible 403).

import { ROUTES } from "@/lib/constants"
import type { ReactNode } from "react"
import { requireAdminUser } from "@/lib/auth-helpers"
import { LayoutWorkspaceHeader } from "@/components/layouts/workspace/header"
import { LayoutAdminTabs } from "@/components/layouts/admin/tabs"
import { workspaceHeaderViewer } from "@/lib/authz/workspace-header"

export default async function AdminLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireAdminUser(ROUTES.admin)

  return (
    <div className="flex min-h-screen flex-col">
      <LayoutWorkspaceHeader viewer={workspaceHeaderViewer(user)} project={null} />
      <LayoutAdminTabs />
      {/* Wider than the workspace pages: admin tables (Accounts has 11 columns)
          are data-dense and would otherwise overflow a max-w-5xl column. */}
      <main className="mx-auto w-full max-w-7xl px-6 py-12">{children}</main>
    </div>
  )
}
