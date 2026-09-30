"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "@/i18n/navigation"
import { apiFetch } from "@/lib/api-fetch"
import { ROUTES } from "@/lib/constants"
import { Button } from "@/components/ui/button"

export function SignOutButton() {
  const t = useTranslations("common")
  const router = useRouter()
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle")

  async function handleSignOut() {
    setState("submitting")
    // better-auth parses every POST body as JSON and answers 400 to an empty
    // one, so the sign-out call has to carry an explicit `{}`.
    const response = await apiFetch("/api/auth/sign-out", {
      method: "POST",
      body: JSON.stringify({}),
    })
    if (!response.ok) {
      setState("error")
      return
    }
    router.replace(ROUTES.signIn)
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void handleSignOut()}
        disabled={state === "submitting"}
      >
        {state === "submitting" ? t("loading") : t("signOut")}
      </Button>
      {state === "error" && (
        <span className="text-xs text-destructive">{t("error")}</span>
      )}
    </div>
  )
}
