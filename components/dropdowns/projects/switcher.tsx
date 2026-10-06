"use client"

// components/dropdowns/projects/switcher.tsx
// DropdownProjectSwitcher — the header's project picker, on the shadcn
// DropdownMenu (Base UI Menu: roving focus, typeahead, Escape and outside
// click, focus return). The trigger shows the open project; the menu opens
// with « Tous les projets » (back to the list), then the caller's projects
// (loading, error with retry, empty with « Nouveau projet », list), then
// « Nouveau projet ».
//
// The create dialog is not owned here: « Nouveau projet » calls
// `onCreateProject`, and the project shell renders the dialog at its level.

import type { ComponentProps } from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { ArrowLeft, Check, ChevronDown, Plus, Rows3 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { useProjects } from "@/hooks/api/projects"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { ROUTES } from "@/lib/constants"
import { cn } from "@/lib/utils"
import type { ProjectListItem } from "@/models/projects/schema"

/** Placeholder rows while the project list loads. */
const SWITCHER_SKELETON_ROWS = 3

interface DropdownProjectSwitcherProps {
  /** The project currently open in the workspace. */
  projectId: string
  /**
   * Its name, from the server (the project layout). The trigger shows it even
   * when the project is not in the caller's own list — an admin opening a
   * foreign project — and before that list has loaded.
   */
  projectName: string
  onCreateProject: () => void
}

export function DropdownProjectSwitcher({
  projectId,
  projectName,
  onCreateProject,
}: DropdownProjectSwitcherProps) {
  const t = useTranslations("nav.switcher")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={t("switchProject")}
        className="group flex items-center gap-2 rounded-md border bg-card py-1 pr-2.5 pl-2 outline-none transition-colors hover:border-brand-teal/45 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Rows3 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-56 truncate text-[12.5px] font-semibold text-foreground">
          {projectName}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-popup-open:rotate-180" />
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-auto min-w-72.5">
        <SwitcherLinkItem href={ROUTES.projects} className="gap-2.5 p-2 font-semibold">
          <ArrowLeft className="text-muted-foreground" />
          {t("allProjects")}
        </SwitcherLinkItem>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel className="mono-eyebrow">{t("workspace")}</DropdownMenuLabel>
          <SwitcherProjects projectId={projectId} onCreateProject={onCreateProject} />
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={onCreateProject}
          className="gap-2.5 p-2 font-semibold text-brand-teal"
        >
          <Plus />
          {t("newProject")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A menu entry that navigates: Base UI's Menu.LinkItem rendering the
 * locale-aware Link, styled like DropdownMenuItem. Local to the switcher until
 * a third unrelated consumer earns it a place in components/ui
 * (playbook/new-primitives.md, Gate 5).
 */
function SwitcherLinkItem({
  href,
  className,
  children,
}: { href: string } & Pick<ComponentProps<"a">, "className" | "children">) {
  return (
    <MenuPrimitive.LinkItem
      closeOnClick
      render={<Link href={href} />}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
    >
      {children}
    </MenuPrimitive.LinkItem>
  )
}

/** The caller's projects: loading → error → empty → list. */
function SwitcherProjects({
  projectId,
  onCreateProject,
}: {
  projectId: string
  onCreateProject: () => void
}) {
  const t = useTranslations("nav.switcher")
  const tCommon = useTranslations("common")
  const projects = useProjects()

  if (projects.isPending) {
    return (
      <div className="flex flex-col gap-1 p-1" aria-busy>
        {Array.from({ length: SWITCHER_SKELETON_ROWS }, (_, i) => (
          <div key={i} className="flex items-center gap-2.5 p-1">
            <Skeleton className="size-4 rounded-sm" />
            <div className="flex flex-1 flex-col gap-1">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (projects.isError) {
    return (
      <>
        <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
          {t("projectsError")}
        </p>
        <DropdownMenuItem closeOnClick={false} onClick={() => void projects.refetch()}>
          {tCommon("tryAgain")}
        </DropdownMenuItem>
      </>
    )
  }

  if (projects.data.length === 0) {
    return (
      <>
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("projectsEmpty")}</p>
        <DropdownMenuItem onClick={onCreateProject} className="text-brand-teal">
          <Plus />
          {t("createFirst")}
        </DropdownMenuItem>
      </>
    )
  }

  return projects.data.map((p) => (
    <SwitcherProjectItem key={p.id} project={p} active={p.id === projectId} />
  ))
}

function SwitcherProjectItem({ project, active }: { project: ProjectListItem; active: boolean }) {
  const t = useTranslations("nav.switcher")
  const locale = useLocale()
  const count = project.corpusSize.toLocaleString(locale)

  return (
    <SwitcherLinkItem
      href={ROUTES.constituer(project.id)}
      className={cn("gap-2.5 p-2", active && "bg-accent/50")}
    >
      <Rows3 className={cn("size-4", active ? "text-brand-teal" : "text-muted-foreground")} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-[13px] font-semibold text-foreground">{project.name}</span>
        <span className="truncate font-mono text-[10.5px] text-muted-foreground">
          {project.subtitle
            ? t("projectMeta", { count, subtitle: project.subtitle })
            : count}
        </span>
      </span>
      {active && <Check className="size-3.5 text-brand-teal" />}
    </SwitcherLinkItem>
  )
}
