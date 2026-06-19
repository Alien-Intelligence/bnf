"use client"

// components/ui/toast.tsx
// A minimal, on-brand toast: a single bottom-center pill that auto-dismisses,
// matching the design prototype (BnF Corpus Research.dc.html line 860). Exposed
// app-wide via ToastProvider + the useToast() hook. Domain-agnostic UI — no BnF
// vocabulary — so it lives in components/ui (passes the new-primitive gates).

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react"

const TOAST_DURATION_MS = 2600

interface ToastContextValue {
  toast: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null)
  // A monotonic key forces the enter animation to replay on a rapid second toast.
  const [key, setKey] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current)
    setMessage(next)
    setKey((k) => k + 1)
    timer.current = setTimeout(() => setMessage(null), TOAST_DURATION_MS)
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {message !== null && (
        <div
          key={key}
          role="status"
          aria-live="polite"
          className="animate-bnf-up pointer-events-none fixed bottom-7 left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap rounded-full bg-foreground px-[18px] py-2.5 text-[12.5px] font-medium text-background shadow-lg"
        >
          {message}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error("useToast must be used within a ToastProvider")
  return ctx
}
