// components/layouts/auth/shell.tsx
// LayoutAuthShell — the dark Alien × BnF split layout shared by sign-in, sign-up
// and forgot-password. Left: a brand panel (glyph + co-brand + value-prop copy),
// hidden on small screens. Right: the form (children), always centered. The DS
// voice rules apply to the copy: sentence case, possessive triad, no emoji.

import Image from "next/image"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"

export function LayoutAuthShell({ children }: { children: ReactNode }) {
  const t = useTranslations("auth.brand")

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r bg-card p-12 lg:flex">
        <div className="flex items-center gap-3">
          <Image
            src="/brand/logo-w.svg"
            alt="Alien Intelligence"
            width={1048}
            height={153}
            priority
            className="h-5 w-auto opacity-90"
          />
          <div className="h-6 w-px bg-border" aria-hidden />
          <Image
            src="/brand/bnf-logo-w.png"
            alt="BnF — Bibliothèque nationale de France"
            width={960}
            height={359}
            priority
            className="h-5.5 w-auto opacity-90"
          />
        </div>

        <div className="space-y-4">
          <Image
            src="/brand/glyph-w.svg"
            alt=""
            width={19}
            height={27}
            priority
            className="h-12 w-auto opacity-90"
          />
          <span className="mono-eyebrow block">{t("eyebrow")}</span>
          <h2 className="max-w-md text-3xl font-semibold leading-tight">
            {t("title")}
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("tagline")}
          </p>
        </div>

        <span className="font-mono text-[11px] text-muted-foreground">
          {t("footer")}
        </span>
      </aside>

      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  )
}
