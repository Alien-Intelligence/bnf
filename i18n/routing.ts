import { defineRouting } from "next-intl/routing"
import { APP_LOCALES, DEFAULT_LOCALE } from "@/lib/constants"

export const routing = defineRouting({
  locales: APP_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
})

export type AppLocale = (typeof routing.locales)[number]
