// lib/format.ts
// Small, framework-free formatting helpers shared across cards/lists.
// Relative-time strings are French (the app's default working language); the
// agent's own output is never passed through here — see playbook/i18n.md.

/**
 * Compact French relative time: "à l'instant", "il y a 5 min", "il y a 3 h",
 * "il y a 2 j", then an absolute "12 mars" beyond a week. Used by the session
 * list and the research artefacts picker so they read identically.
 */
export function formatRelativeFr(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date
  const diff = Date.now() - d.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return "à l'instant"
  if (diff < hour) return `il y a ${Math.floor(diff / minute)} min`
  if (diff < day) return `il y a ${Math.floor(diff / hour)} h`
  if (diff < 7 * day) return `il y a ${Math.floor(diff / day)} j`
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })
}
