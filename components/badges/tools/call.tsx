// components/badges/tools/call.tsx
// Renders a chip for a single tool call event inside the chat panel.
// Shows the tool label (i18n), source suffix, status icon, and optional latency.
// Client component — reads translations and the tool status at render time.

"use client"

import { Check, Loader2, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface Props {
  tool: string
  status: "running" | "ok" | "error"
  source: "custom" | "mcp"
  latencyMs?: number | null
  error?: string | null
}

/**
 * Derives the i18n key from the raw tool name.
 *
 * - Custom tools use the tool name as-is, replacing dots with dots
 *   (e.g. "corpus.add" → key "corpus.add").
 * - MCP tools arrive as "bnf__bnf_search_gallica"; we strip the
 *   "<server>__<server>_" prefix and produce "bnf.search_gallica".
 *
 * The key is looked up in the "tools" namespace.
 */
function deriveI18nKey(tool: string, source: "custom" | "mcp"): string {
  if (source === "mcp") {
    // MCP tool pattern: "<server>__<server>_<suffix>"
    // e.g. "bnf__bnf_search_gallica" → "bnf.search_gallica"
    const mcpMatch = /^(\w+)__\1_(.+)$/.exec(tool)
    if (mcpMatch) {
      const [, server, suffix] = mcpMatch
      return `${server}.${suffix}`
    }
    // Fallback for unexpected MCP naming: strip double-underscore prefix
    const fallback = tool.replace(/^[^_]+__/, "")
    return fallback.replace("_", ".")
  }
  return tool
}

function LatencyLabel({ ms }: { ms: number }) {
  const seconds = (ms / 1000).toFixed(1)
  return <span className="text-muted-foreground">· {seconds}s</span>
}

export function BadgeToolCall({ tool, status, source, latencyMs, error }: Props) {
  const t = useTranslations("tools")

  const i18nKey = deriveI18nKey(tool, source)
  // next-intl throws if the key is missing — use has() guard and fall back to
  // the raw tool name. This prevents crashes for future tools not yet in the
  // catalog before both files are updated in concert.
  const label = t.has(i18nKey) ? t(i18nKey) : tool
  const sourceSuffix = source === "mcp" ? " · via MCP" : null

  const variant =
    status === "running" ? "outline"
    : status === "error"  ? "destructive"
    : "secondary"

  return (
    <Badge
      variant={variant}
      className={cn("gap-1 font-mono text-[11px]", status === "error" && "cursor-help")}
      title={status === "error" && error ? error : undefined}
    >
      {status === "running" && (
        <Loader2 className="animate-spin" aria-hidden="true" />
      )}
      {status === "ok" && (
        <Check aria-hidden="true" />
      )}
      {status === "error" && (
        <X aria-hidden="true" />
      )}

      <span>
        {label}
        {sourceSuffix}
      </span>

      {status === "ok" && latencyMs != null && (
        <LatencyLabel ms={latencyMs} />
      )}
    </Badge>
  )
}
