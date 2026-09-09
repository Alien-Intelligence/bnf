"use client"

// components/layouts/workspace/step-nav.tsx
// LayoutWorkspaceStepNav — the Constituer → Ingérer → Rechercher progression in
// the workspace header. Derives the active step from the current pathname and
// renders the prototype's numbered-dot + connecting-line treatment: steps before
// the active one show a check, the active one is highlighted, later ones are
// pending. See design/BnF Corpus Research.dc.html (header <nav>, lines 91-106).

import { Check } from "lucide-react"
import { useTranslations } from "next-intl"
import { Link, usePathname } from "@/i18n/navigation"
import { ROUTES, WORKSPACE_STEPS, type WorkspaceStep } from "@/lib/constants"
import { cn } from "@/lib/utils"

interface LayoutWorkspaceStepNavProps {
  projectId: string
  /**
   * The steps this user actually has on this project. A read-only member and a
   * derived workspace both get Rechercher alone: showing a step that answers
   * 404 is worse than not showing it. Defaults to the full progression.
   */
  steps?: readonly WorkspaceStep[]
}

const STEP_HREF: Record<WorkspaceStep, (projectId: string) => string> = {
  constituer: ROUTES.constituer,
  ingerer: ROUTES.ingerer,
  rechercher: ROUTES.rechercher,
}

function activeStepFromPathname(pathname: string): WorkspaceStep {
  // Carnet is a sub-view of Rechercher; match it to the rechercher step.
  if (pathname.includes("/rechercher")) return "rechercher"
  if (pathname.includes("/ingerer")) return "ingerer"
  return "constituer"
}

export function LayoutWorkspaceStepNav({
  projectId,
  steps = WORKSPACE_STEPS,
}: LayoutWorkspaceStepNavProps) {
  const t = useTranslations("nav")
  const pathname = usePathname()
  const activeStep = activeStepFromPathname(pathname)
  const activeIndex = steps.indexOf(activeStep)

  // A single-step progression is not a progression — the numbered dots would
  // read as "step 1 of 1" and say nothing.
  if (steps.length < 2) return null

  return (
    <nav className="flex items-center gap-1" aria-label={t("constituer")}>
      {steps.map((step, index) => {
        const isDone = index < activeIndex
        const isActive = index === activeIndex

        return (
          <div key={step} className="flex items-center gap-1">
            {index > 0 && (
              <div className="mx-0.5 h-px w-6 bg-border" aria-hidden />
            )}
            <Link
              href={STEP_HREF[step](projectId)}
              aria-current={isActive ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full font-mono text-[11px] font-semibold",
                  isActive && "bg-primary text-primary-foreground",
                  isDone && "bg-brand-teal/20 text-brand-teal",
                  !isActive && !isDone && "bg-secondary text-muted-foreground",
                )}
              >
                {isDone ? <Check className="size-3" strokeWidth={3} /> : index + 1}
              </span>
              <span className={cn("font-medium", isActive && "text-foreground")}>
                {t(step)}
              </span>
            </Link>
          </div>
        )
      })}
    </nav>
  )
}
