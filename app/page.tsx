// The root `/` path is rewritten by the next-intl proxy (proxy.ts) to the
// default locale, so app/[locale]/page.tsx renders for it and owns the
// session-aware redirect (projects when signed in, sign-in otherwise).
// This file only satisfies Next.js's requirement for a page at the root
// segment; it is never rendered in normal operation.
export default function RootPage() {
  return null
}
