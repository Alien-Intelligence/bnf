"use client"

// components/providers/thinking.tsx
// A single app-wide "are thinking blocks expanded?" preference. Every
// ThinkingBox in the chat reflects this one boolean, so collapsing/expanding
// any block collapses/expands them all — and the choice sticks across turns and
// reloads (localStorage), the way Claude Code's thinking toggle behaves.

import { createContext, useContext, useState } from "react"

const STORAGE_KEY = "bnf.thinking-expanded"

type ThinkingContextValue = {
  expanded: boolean
  setExpanded: (expanded: boolean) => void
  toggle: () => void
}

const ThinkingContext = createContext<ThinkingContextValue | null>(null)

export function ThinkingProvider({ children }: { children: React.ReactNode }) {
  // Default expanded (matches the prior per-box default), overridden by the
  // persisted preference. Read lazily rather than in an effect: thinking blocks
  // only render from client-streamed chat turns (never in the SSR HTML), so
  // reading localStorage at init can't cause a hydration mismatch here.
  const [expanded, setExpandedState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return stored === null ? true : stored === "true"
  })

  const setExpanded = (next: boolean) => {
    setExpandedState(next)
    window.localStorage.setItem(STORAGE_KEY, String(next))
  }

  return (
    <ThinkingContext.Provider
      value={{ expanded, setExpanded, toggle: () => setExpanded(!expanded) }}
    >
      {children}
    </ThinkingContext.Provider>
  )
}

export function useThinkingExpanded(): ThinkingContextValue {
  const ctx = useContext(ThinkingContext)
  if (!ctx) {
    throw new Error("useThinkingExpanded must be used within a ThinkingProvider")
  }
  return ctx
}
