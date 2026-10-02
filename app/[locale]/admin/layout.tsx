// app/[locale]/admin/layout.tsx
// Admin console shell — shared by every admin tab (overview, accounts,
// feedback, usage, …). Owns the co-branded header, the tab-nav and the centred
// main column, so each tab's client renders only its own content.
//
// It never gates (playbook/page-structure.md « Project shell », same rule): a
// layout does not re-render on client navigation between tabs and cannot see
// the pathname (Next 16, "Layouts and auth checks"), so it could neither keep
// the check fresh nor build the right `?next=`. Every tab page runs its own
// requireAdminUser(ROUTES.<tab>). Without an admin session the layout renders
// the page bare, and the page redirects to sign-in (with its own path) or
// answers notFound() (404, not a visible 403).

import type { ReactNode } from "react"
import { findSessionUser } from "@/lib/auth-helpers"
import { LayoutWorkspaceHeader } from "@/components/layouts/workspace/header"
import { LayoutAdminTabs } from "@/components/layouts/admin/tabs"
import { mayOpenAdminConsole, workspaceHeaderViewer } from "@/lib/authz/workspace-header"

export default async function AdminLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await findSessionUser()
  if (!user || !mayOpenAdminConsole(user)) return children

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
