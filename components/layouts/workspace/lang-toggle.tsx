"use client"

// components/layouts/workspace/lang-toggle.tsx
// LayoutWorkspaceLangToggle — a small FR / EN switch in the workspace header.
// Swaps the active next-intl locale while staying on the current path. Uses the
// locale-aware router/pathname from @/i18n/navigation so the `as-needed` prefix
// strategy is honoured (fr → no prefix, en → /en). The agent's streamed output
// is not affected — only the static UI chrome is re-rendered in the new locale.

import { useTransition } from "react"
import { useLocale, useTranslations } from "next-intl"
import { usePathname, useRouter } from "@/i18n/navigation"
import { routing } from "@/i18n/routing"
import { cn } from "@/lib/utils"

export function LayoutWorkspaceLangToggle() {
  const t = useTranslations("nav")
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function switchTo(next: string) {
    if (next === locale) return
    startTransition(() => {
      router.replace(pathname, { locale: next })
    })
  }

  return (
    <div
      className="inline-flex items-center rounded-md border bg-secondary/40 p-0.5 font-mono text-[11px]"
      role="group"
      aria-label={t("language")}
    >
      {routing.locales.map((code) => {
        const isActive = code === locale
        return (
          <button
            key={code}
            type="button"
            onClick={() => switchTo(code)}
            disabled={isPending}
            aria-pressed={isActive}
            className={cn(
              "rounded px-1.5 py-0.5 uppercase transition-colors disabled:opacity-60",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {code}
          </button>
        )
      })}
    </div>
  )
}
