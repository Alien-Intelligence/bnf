"use client"

// components/buttons/auth/sign-out.tsx
// ButtonAuthSignOut — the header's « Se déconnecter ». Calls POST /api/sign-out
// and then leaves with a FULL document navigation to the URL the server
// returns (the sign-in page, or Authentik's end-session endpoint).
//
// Why window.location.assign and not router.push / router.refresh: a fetch to
// a route handler does not invalidate the Next Client Cache, and
// router.refresh() clears it "for the current route" only (node_modules/next/
// dist/docs/01-app/04-glossary.md "Client Cache"; 03-api-reference/04-functions/
// use-router.md). A soft navigation after sign-out would let Back show a cached
// authenticated page with its data. A document navigation discards every
// cached route — and is the only thing that can cross to Authentik's origin.

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useSignOut } from "@/hooks/api/users"

export function ButtonAuthSignOut() {
  const t = useTranslations("common")
  const signOut = useSignOut()
  // Success is not "idle again": the document navigation is still in flight,
  // so the button stays busy until the page unloads (no second click, no
  // flash of « Se déconnecter »).
  const busy = signOut.isPending || signOut.isSuccess

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() =>
          signOut.mutate(undefined, {
            onSuccess: (result) => window.location.assign(result.redirectTo),
          })
        }
      >
        {busy ? t("loading") : t("signOut")}
      </Button>
      {signOut.isError && (
        <span role="alert" className="text-xs text-destructive">
          {t("signOutError")}
        </span>
      )}
    </div>
  )
}
