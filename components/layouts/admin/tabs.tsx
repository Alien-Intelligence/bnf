"use client"

// components/layouts/admin/tabs.tsx
// LayoutAdminTabs — the tab-nav for the admin console (Overview · Accounts ·
// Feedback · Usage). Derives the active tab from the current pathname and
// renders an underlined-tab treatment consistent with the workspace chrome.
// Rendered once by app/[locale]/admin/layout.tsx above every admin tab.

import { useTranslations } from "next-intl"
import { Link, usePathname } from "@/i18n/navigation"
import { ADMIN_TABS, ADMIN_TAB_HREF, type AdminTab } from "@/lib/constants"
import { cn } from "@/lib/utils"

function activeTabFromPathname(pathname: string): AdminTab {
  const match = ADMIN_TABS.find((tab) => pathname.includes(`/admin/${tab}`))
  return match ?? "overview"
}

export function LayoutAdminTabs() {
  const t = useTranslations("admin.nav")
  const pathname = usePathname()
  const activeTab = activeTabFromPathname(pathname)

  return (
    <nav
      className="flex items-center gap-1 border-b px-6"
      aria-label={t("title")}
    >
      {ADMIN_TABS.map((tab) => {
        const isActive = tab === activeTab
        return (
          <Link
            key={tab}
            href={ADMIN_TAB_HREF[tab]}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-3 text-sm font-medium transition-colors",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(tab)}
          </Link>
        )
      })}
    </nav>
  )
}
