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
// The one cache it does not reach is the browser's back/forward cache, hence
// leaveForGood() below.

import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { getPathname } from "@/i18n/navigation"
import { ROUTES } from "@/lib/constants"
import { SessionAlreadyEndedError, useSignOut } from "@/hooks/api/users"

export function ButtonAuthSignOut() {
  const t = useTranslations("auth.signOut")
  const locale = useLocale()
  const signOut = useSignOut()
  const alreadyEnded = signOut.error instanceof SessionAlreadyEndedError
  // Success is not "idle again": the document navigation is still in flight,
  // so the button stays busy until the page unloads (no second click, no
  // flash of « Se déconnecter »). Same when the session had already ended.
  const busy = signOut.isPending || signOut.isSuccess || alreadyEnded

  const leave = (href: string) => {
    leaveForGood()
    window.location.assign(href)
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() =>
          signOut.mutate(undefined, {
            onSuccess: (result) => leave(result.redirectTo),
            // The goal — no live session — was already met before this click
            // (another tab, or expiry). Go to plain sign-in: no « déconnecté »
            // notice, because this request ended nothing.
            onError: (error) => {
              if (error instanceof SessionAlreadyEndedError) {
                leave(getPathname({ href: ROUTES.signIn, locale }))
              }
            },
          })
        }
      >
        {busy ? t("pending") : t("action")}
      </Button>
      {signOut.isError && !alreadyEnded && (
        <span role="alert" className="text-xs text-destructive">
          {t("error")}
        </span>
      )}
    </div>
  )
}

/**
 * The browser's back/forward cache can still restore THIS document, data and
 * all, when the user presses Back after signing out (observed in Chrome: the
 * page came back with the button frozen on « Chargement… »). A restored page
 * runs no request, so nothing re-checks the session. Reload it on restore:
 * the server then sees no session and redirects to sign-in.
 */
function leaveForGood(): void {
  window.addEventListener(
    "pageshow",
    (event) => {
      if (event.persisted) window.location.reload()
    },
    { once: true },
  )
}
