"use client"

// components/layouts/workspace/header.tsx
// WorkspaceHeader — the co-branded Alien Intelligence × BnF top bar shared by
// every workspace screen. Left: Alien wordmark · divider · BnF logo · optional
// project label. Centre: the step-nav (only on a project). Right: MCP status +
// user menu. Mirrors design/BnF Corpus Research.dc.html header (lines 34-114).
//
// Client component: the step-nav needs the pathname and the user menu is
// interactive, so this cannot be an async server component (next-intl's client
// useTranslations is used, provided by NextIntlClientProvider in the layout).

import Image from "next/image"
import { useTranslations } from "next-intl"
import { LayoutWorkspaceStepNav } from "./step-nav"
import { LayoutWorkspaceProjectSwitcher } from "./project-switcher"
import { LayoutWorkspaceLangToggle } from "./lang-toggle"
import { SignOutButton } from "./sign-out-button"

interface WorkspaceHeaderProps {
  user: { name?: string; email: string }
  /** When present, the step-nav and project switcher render. */
  projectId?: string
}

function initials(user: { name?: string; email: string }): string {
  const source = user.name?.trim() || user.email
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

/** Discreet build identifier beside the MCP indicator — `v<version>` plus the
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

export function WorkspaceHeader({
  user,
  projectId,
}: WorkspaceHeaderProps) {
  const t = useTranslations("nav")

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-background/85 px-4.5 backdrop-blur-md">
      {/* Brand + project cluster */}
      <div className="flex min-w-0 items-center gap-3">
        <Image
          src="/brand/logo-w.svg"
          alt="Alien Intelligence"
          width={1048}
          height={153}
          priority
          className="h-4.5 w-auto opacity-90"
        />
        <div className="h-6.5 w-px bg-border" aria-hidden />
        <Image
          src="/brand/bnf-logo-w.png"
          alt="BnF — Bibliothèque nationale de France"
          title="Bibliothèque nationale de France"
          width={960}
          height={359}
          priority
          className="h-5 w-auto opacity-90"
        />
        {projectId && (
          <>
            <div className="h-6.5 w-px bg-border" aria-hidden />
            <LayoutWorkspaceProjectSwitcher projectId={projectId} />
          </>
        )}
      </div>

      {/* Step navigation — only inside a project workspace */}
      {projectId && <LayoutWorkspaceStepNav projectId={projectId} />}

      {/* Version + MCP status + user menu */}
      <div className="flex items-center gap-3">
        <AppVersion />
        <LayoutWorkspaceLangToggle />
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <span
            className="size-1.75 rounded-full bg-info shadow-[0_0_8px_var(--info)]"
            aria-hidden
          />
          MCP
        </span>
        <span
          className="flex size-7 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-foreground"
          title={user.name ?? user.email}
          aria-label={t("userMenu")}
        >
          {initials(user)}
        </span>
        <SignOutButton />
      </div>
    </header>
  )
}
