// components/layouts/shared/empty-state.tsx
// LayoutSharedEmptyState — the standard "nothing here yet" block: a muted Lucide
// icon, a sentence-case title, an optional description, and an optional action.
// Reused across projects, corpus, notes and sessions so every empty surface
// reads the same (playbook/ui-states: empty states are meaningful, never blank).

import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

interface LayoutSharedEmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}

export function LayoutSharedEmptyState({
  icon: Icon,
  title,
  description,
  action,
}: LayoutSharedEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <Icon className="size-10 text-muted-foreground/60" strokeWidth={1.5} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  )
}
