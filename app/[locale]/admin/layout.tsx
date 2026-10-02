// app/[locale]/admin/layout.tsx
// Admin console shell — shared by every admin tab (overview, accounts,
// feedback, usage). Owns the single access gate (requireAdminUser), the
// co-branded header, the tab-nav, and the centred main column, so each tab's
// client renders only its own content. A non-admin hits notFound() here (404,
// not a visible 403) before any tab code runs.

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
  const user = await requireAdminUser("/admin")

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
