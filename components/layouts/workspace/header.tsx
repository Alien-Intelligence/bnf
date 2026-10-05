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
// Inside a project it is mounted once, by LayoutWorkspaceProjectShell under
// app/[locale]/projects/[projectId]/layout.tsx, from server data
// (lib/authz/workspace-header.ts): the step list, the share button and the
// admin link come from the same predicates the routes and pages enforce.
//
// Client component: the step-nav needs the pathname and the switcher and share
// button are interactive, so this cannot be an async server component
// (next-intl's client useTranslations is used, provided by
// NextIntlClientProvider in the layout).

import Image from "next/image"
import { ShieldUser } from "lucide-react"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { BRAND_ASSET, ROUTES } from "@/lib/constants"
import type {
  WorkspaceHeaderProject,
  WorkspaceHeaderViewer,
} from "@/lib/authz/workspace-header"
import { LayoutWorkspaceStepNav } from "./step-nav"
import { LayoutWorkspaceProjectNav } from "./project-nav"
import { LayoutWorkspaceLangToggle } from "./lang-toggle"
import { WorkspaceHealthStatus } from "./health-status"
import { ButtonAuthSignOut } from "@/components/buttons/auth/sign-out"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

type HeaderUser = Pick<WorkspaceHeaderViewer, "name" | "email">

interface LayoutWorkspaceHeaderProps {
  /** Who is signed in, and whether the admin link shows (workspaceHeaderViewer). */
  viewer: WorkspaceHeaderViewer
  /**
   * The open project, decided on the server (workspaceHeaderProject). `null`
   * outside a project: the projects list and the admin console. Inside one,
   * the header sits under LayoutWorkspaceProjectShell, whose dialogs the
   * project cluster opens.
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
  const t = useTranslations("nav.version")
  const version = process.env.NEXT_PUBLIC_APP_VERSION
  if (!version) return null
  const sha = process.env.NEXT_PUBLIC_GIT_SHA
  return (
    <span
      className="hidden font-mono text-[10px] text-muted-foreground/60 select-none sm:inline"
      title={sha ? t("titleWithSha", { version, sha }) : t("title", { version })}
    >
      {sha ? t("labelWithSha", { version, sha }) : t("label", { version })}
    </span>
  )
}

export function LayoutWorkspaceHeader({ viewer, project }: LayoutWorkspaceHeaderProps) {
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
            src={BRAND_ASSET.ALIEN_LOGO.src}
            alt={tBrand("alien")}
            width={BRAND_ASSET.ALIEN_LOGO.width}
            height={BRAND_ASSET.ALIEN_LOGO.height}
            priority
            className="h-4.5 w-auto"
          />
          <Separator orientation="vertical" className="data-vertical:h-6.5 data-vertical:self-center" />
          <Image
            src={BRAND_ASSET.BNF_LOGO.src}
            alt={tBrand("bnf")}
            width={BRAND_ASSET.BNF_LOGO.width}
            height={BRAND_ASSET.BNF_LOGO.height}
            priority
            className="h-5 w-auto"
          />
        </Link>
        {project && <LayoutWorkspaceProjectNav project={project} />}
      </div>

      {/* Step navigation — only inside a project workspace */}
      {project && (
        <LayoutWorkspaceStepNav projectId={project.id} steps={project.steps} />
      )}

      {/* Version + admin + language + MCP status + user */}
      <div className="flex items-center gap-3">
        <AppVersion />
        {viewer.isAdmin && (
          <Link
            href={ROUTES.admin}
            title={t("admin")}
            aria-label={t("admin")}
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <ShieldUser className="size-4" />
          </Link>
        )}
        <LayoutWorkspaceLangToggle />
        <WorkspaceHealthStatus />
        {/* An avatar, not a menu: it opens nothing, so it says who is signed in
            rather than claiming to be a « Menu utilisateur ». */}
        <Avatar
          size="sm"
          role="img"
          title={displayName(viewer)}
          aria-label={t("signedInAs", { name: displayName(viewer) })}
        >
          <AvatarFallback className="text-[11px] font-semibold text-foreground">
            {initials(viewer)}
          </AvatarFallback>
        </Avatar>
        <ButtonAuthSignOut />
      </div>
    </header>
  )
}
