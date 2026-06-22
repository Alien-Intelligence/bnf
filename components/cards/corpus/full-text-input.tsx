"use client"

// components/cards/corpus/full-text-input.tsx
// Debounced free-text search input for the corpus filter drawer.
// Commits after a configurable debounce delay. Empty string commits as
// undefined (meaning "no filter").
//
// Derived-state sync pattern: we track the last seen external value in a
// state variable so we can detect parent-driven resets without useEffect.
// See https://react.dev/reference/react/useState#storing-information-from-previous-renders

import { useState, useEffect } from "react"
import { useTranslations } from "next-intl"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"

interface Props {
  /** Current committed value (from filter state). */
  value: string | undefined
  /** Called after debounce with the new query; undefined means cleared. */
  onCommit: (q: string | undefined) => void
  /** Debounce window in ms (default 400). */
  debounceMs?: number
}

export function CardCorpusFullTextInput({
  value,
  onCommit,
  debounceMs = 400,
}: Props) {
  const t = useTranslations("corpus.filters")

  // Tracks the last externally committed value so we detect parent-driven
  // resets (e.g. "clear all") and update the local draft accordingly.
  // Pattern: store previous prop in state to compare during render.
  const [prevValue, setPrevValue] = useState(value)
  const [draft, setDraft] = useState(value ?? "")

  // When the external value changes, sync the draft. This runs synchronously
  // during render (not in an effect) to avoid a visual flash.
  if (prevValue !== value) {
    setPrevValue(value)
    setDraft(value ?? "")
  }

  // Debounce: commit draft → parent after the configured delay.
  // Only commit when the value actually CHANGED. `onCommit`'s identity changes
  // on every parent render (it closes over the URL-derived filters), so without
  // this guard the effect would re-commit the same query each render → a
  // navigation per commit → an infinite reload loop (?q=… fetched forever).
  useEffect(() => {
    const id = setTimeout(() => {
      const trimmed = draft.trim()
      const next = trimmed.length > 0 ? trimmed : undefined
      if (next !== value) onCommit(next)
    }, debounceMs)
    return () => clearTimeout(id)
  }, [draft, value, debounceMs, onCommit])

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        type="search"
        className="pl-9"
        placeholder={t("searchPlaceholder")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={t("searchPlaceholder")}
      />
    </div>
  )
}
