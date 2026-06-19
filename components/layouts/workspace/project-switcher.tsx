"use client"

// components/layouts/workspace/project-switcher.tsx
// LayoutWorkspaceProjectSwitcher — the header project picker. A hand-rolled
// dropdown (no dropdown-menu primitive exists, and the prototype's picker is
// itself hand-rolled — design/BnF Corpus Research.dc.html lines 47-88): trigger
// shows the active project's name + subtitle; the panel lists the workspace's
// projects (locale-aware links) and a "Nouveau projet" action that opens the
// shared create dialog.
//
// Client component: owns open state, closes on outside-click / Escape, and
// reads the project list via TanStack Query.

import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, Plus, Rows3 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { useProjects } from "@/hooks/api/projects"
import { DialogProjectCreate } from "@/components/dialogs/projects/create"
import { ROUTES } from "@/lib/constants"
import { cn } from "@/lib/utils"

interface Props {
  /** The project currently open in the workspace. */
  projectId: string
}

export function LayoutWorkspaceProjectSwitcher({ projectId }: Props) {
  const t = useTranslations("nav")
  const { data: projects } = useProjects()
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close on outside-click and Escape (no primitive to handle this for us).
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const active = projects?.find((p) => p.id === projectId)

  function projectMeta(p: { corpusSize: number; subtitle: string | null }): string {
    const count = p.corpusSize.toLocaleString("fr-FR")
    return p.subtitle ? `${count} · ${p.subtitle}` : count
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("switchProject")}
        className="flex items-center gap-2 rounded-md border bg-card py-1 pr-2.5 pl-2 transition-colors hover:border-brand-teal/45"
      >
        <Rows3 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="max-w-56 truncate text-[12.5px] font-semibold text-foreground">
            {active?.name ?? "—"}
          </span>
          {active?.subtitle && (
            <span className="max-w-56 truncate text-[10px] text-muted-foreground">
              {active.subtitle}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-[calc(100%+8px)] left-0 z-50 min-w-72.5 overflow-hidden rounded-lg border bg-card shadow-[0_8px_32px_-8px_rgba(0,0,0,0.55)]"
        >
          <div className="mono-eyebrow px-3 pt-2.5 pb-1.5">{t("workspace")}</div>
          <div className="h-px bg-border mx-3" aria-hidden />

          <div className="flex flex-col gap-0.5 p-1.5">
            {projects?.map((p) => {
              const isActive = p.id === projectId
              return (
                <Link
                  key={p.id}
                  href={ROUTES.constituer(p.id)}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md p-2 transition-colors hover:bg-accent",
                    isActive && "bg-accent/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-md border",
                      isActive
                        ? "border-brand-teal/45 text-brand-teal"
                        : "text-muted-foreground",
                    )}
                  >
                    <Rows3 className="size-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col text-left">
                    <span className="truncate text-[13px] font-semibold text-foreground">
                      {p.name}
                    </span>
                    <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                      {projectMeta(p)}
                    </span>
                  </span>
                  {isActive && (
                    <Check className="size-3.5 shrink-0 text-brand-teal" />
                  )}
                </Link>
              )
            })}
          </div>

          <div className="h-px bg-border mx-3" aria-hidden />
          <div className="p-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setCreateOpen(true)
              }}
              className="flex w-full items-center gap-2.5 rounded-md p-2 text-brand-teal transition-colors hover:bg-brand-teal/10"
            >
              <Plus className="size-4 shrink-0" />
              <span className="text-[13px] font-semibold">{t("newProject")}</span>
            </button>
          </div>
        </div>
      )}

      <DialogProjectCreate open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
