// The root `/` path is handled by the next-intl middleware which redirects to
// the appropriate locale-prefixed path (e.g. `/fr/…` or `/en/…`).
// This file satisfies Next.js's requirement for a page at the root segment;
// it will never actually be rendered in normal operation.
export default function RootPage() {
  return null
}
