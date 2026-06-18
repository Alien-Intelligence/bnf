"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { apiFetch } from "@/lib/api-fetch"
import { Button } from "@/components/ui/button"

export function SignOutButton() {
  const t = useTranslations("common")
  const router = useRouter()
  const [state, setState] = useState<"idle" | "submitting" | "error">("idle")

  async function handleSignOut() {
    setState("submitting")
    const response = await apiFetch("/api/auth/sign-out", { method: "POST" })
    if (!response.ok) {
      setState("error")
      return
    }
    router.push("/sign-in")
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
