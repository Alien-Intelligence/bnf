// components/badges/documents/thumb.tsx
// BadgeDocumentThumb — the page-shaped document thumbnail from the design
// (design/BnF Corpus Research.dc.html thumbStyle/cdThumb): a portrait card with
// a type-colored top edge and faint horizontal "text lines" (a repeating
// gradient), instead of a flat colored square. `color` is the type hue (a CSS
// color, e.g. var(--dataset-3)); pass "var(--muted)" for unresolved stubs.
// Server component — no hooks, usable from client + server parents.

interface Props {
  color: string
  /** "sm" for list rows (34×46), "lg" for the detail panel (86×118). */
  size?: "sm" | "lg"
}

const DIMS = {
  sm: { w: 34, h: 46, top: 3, line: 4, gap: 7, mix: 7, radius: 3 },
  lg: { w: 86, h: 118, top: 4, line: 5, gap: 9, mix: 9, radius: 4 },
} as const

export function BadgeDocumentThumb({ color, size = "sm" }: Props) {
  const d = DIMS[size]
  const tint = `color-mix(in srgb, ${color} ${d.mix}%, var(--background))`
  return (
    <span
      aria-hidden
      className="block shrink-0"
      style={{
        width: d.w,
        height: d.h,
        borderRadius: d.radius,
        border: "1px solid var(--border)",
        borderTopWidth: d.top,
        borderTopColor: color,
        background: `repeating-linear-gradient(0deg, ${tint}, ${tint} ${d.line}px, transparent ${d.line}px, transparent ${d.gap}px)`,
      }}
    />
  )
}
