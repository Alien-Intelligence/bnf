// lib/locale.ts
// Resolve the UI locale a request was made under. The chat client attaches
// the locale as the LOCALE_HEADER on every request (hooks/api/turn-stream.ts);
// API routes (excluded from the next-intl middleware matcher) read it here.
// An absent or unknown value falls back to the routing default — never an
// error: the header is a presentation hint, not a credential.
import { routing, type AppLocale } from "@/i18n/routing"
import { LOCALE_HEADER } from "@/lib/constants"

export function resolveRequestLocale(req: Request): AppLocale {
  const value = req.headers.get(LOCALE_HEADER)
  if (value && (routing.locales as readonly string[]).includes(value)) {
    return value as AppLocale
  }
  return routing.defaultLocale
}
