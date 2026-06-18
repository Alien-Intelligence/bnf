"use client"

// components/providers/query.tsx
// TanStack Query client provider.
// Instantiated once per browser session; the QueryClient is created in
// useState so that each server render gets a fresh client (avoids sharing
// across requests during SSR).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 30 s window before a background refetch is triggered.
            staleTime: 30_000,
          },
        },
      }),
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
