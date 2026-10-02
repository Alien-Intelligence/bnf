"use client"

// components/layouts/workspace/header.tsx
// LayoutWorkspaceHeader — the co-branded Alien Intelligence × BnF top bar shared
// by every workspace screen. Left: Alien wordmark · divider · BnF logo (together
// one link back to the projects list), then, inside a project, the « Projets › »
// crumb, the project switcher and the « Partager » button. Centre: the step-nav
// (only on a project). Right: admin link, language, MCP status, the signed-in
// user's initials and sign-out. Mirrors design/BnF Corpus Research.dc.html
// header (lines 34-114).
//
// Inside a project it is mounted once, by app/[locale]/projects/[projectId]/
// layout.tsx, from server data (lib/authz/workspace-header.ts): the step list
// and the share button come from the same predicates the routes enforce.
//
// Client component: the step-nav needs the pathname and the switcher and share
// button are interactive, so this cannot be an async server component
// (next-intl's client useTranslations is used, provided by
// NextIntlClientProvider in the layout).

import Image from "next/image"
import { ChevronRight, ShieldUser } from "lucide-react"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { ROUTES } from "@/lib/constants"
import type { WorkspaceHeaderProject } from "@/lib/authz/workspace-header"
import { LayoutWorkspaceStepNav } from "./step-nav"
import { LayoutWorkspaceProjectSwitcher } from "./project-switcher"
import { LayoutWorkspaceShare } from "./share"
import { LayoutWorkspaceLangToggle } from "./lang-toggle"
import { WorkspaceHealthStatus } from "./health-status"
import { ButtonAuthSignOut } from "@/components/buttons/auth/sign-out"

type HeaderUser = { name: string; email: string }

interface LayoutWorkspaceHeaderProps {
  user: HeaderUser
  /** Reveals the discreet link to the admin console, on every page. */
  isAdmin: boolean
  /**
   * The open project, decided on the server (workspaceHeaderProject). `null`
   * outside a project: the projects list and the admin console.
   */
  project: WorkspaceHeaderProject | null
}

/** The name when there is one, else the email: what the avatar stands for. */
function displayName(user: HeaderUser): string {
  return user.name.trim() || user.email
}

function initials(user: HeaderUser): string {
  const source = displayName(user)
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

/** Discreet build identifier beside the health indicator — `v<version>` plus the
 *  git short SHA when available. Both inlined at build (next.config.ts). Helps
 *  pin down which build is running when debugging. */
function AppVersion() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION
  if (!version) return null
  const sha = process.env.NEXT_PUBLIC_GIT_SHA
  const label = sha ? `v${version}·${sha}` : `v${version}`
  return (
    <span
      className="hidden font-mono text-[10px] text-muted-foreground/60 select-none sm:inline"
      title={sha ? `Version ${version} · ${sha}` : `Version ${version}`}
    >
      {label}
    </span>
  )
}

export function LayoutWorkspaceHeader({
  user,
  isAdmin,
  project,
}: LayoutWorkspaceHeaderProps) {
  const t = useTranslations("nav")
  const tBrand = useTranslations("brand")

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-background/85 px-4.5 backdrop-blur-md">
      {/* Brand + project cluster */}
      <div className="flex min-w-0 items-center gap-3">
        <Link
          href={ROUTES.projects}
          title={t("homeLink")}
          aria-label={t("homeLink")}
          className="flex items-center gap-3 rounded-md opacity-90 outline-none transition-opacity hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Image
            src="/brand/logo-w.svg"
            alt={tBrand("alien")}
            width={1048}
            height={153}
            priority
            className="h-4.5 w-auto"
          />
          <div className="h-6.5 w-px bg-border" aria-hidden />
          <Image
            src="/brand/bnf-logo-w.png"
            alt={tBrand("bnf")}
            width={960}
            height={359}
            priority
            className="h-5 w-auto"
          />
        </Link>
        {project && (
          <>
            <div className="h-6.5 w-px bg-border" aria-hidden />
            <div className="flex min-w-0 items-center gap-1.5">
              <Link
                href={ROUTES.projects}
                className="rounded-sm text-[12.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {t("projectsCrumb")}
              </Link>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <LayoutWorkspaceProjectSwitcher
                projectId={project.id}
                projectName={project.name}
              />
            </div>
            {project.mayShare && (
              <LayoutWorkspaceShare projectId={project.id} projectName={project.name} />
            )}
          </>
        )}
      </div>

      {/* Step navigation — only inside a project workspace */}
      {project && (
        <LayoutWorkspaceStepNav projectId={project.id} steps={project.steps} />
      )}

      {/* Version + admin + language + MCP status + user */}
      <div className="flex items-center gap-3">
        <AppVersion />
        {isAdmin && (
          <Link
            href={ROUTES.admin}
            title={t("admin")}
            aria-label={t("admin")}
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ShieldUser className="size-4" />
          </Link>
        )}
        <LayoutWorkspaceLangToggle />
        <WorkspaceHealthStatus />
        {/* An avatar, not a menu: it opens nothing, so it says who is signed in
            rather than claiming to be a « Menu utilisateur ». */}
        <span
          role="img"
          className="flex size-7 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-foreground"
          title={displayName(user)}
          aria-label={t("signedInAs", { name: displayName(user) })}
        >
          {initials(user)}
        </span>
        <ButtonAuthSignOut />
      </div>
    </header>
  )
}
