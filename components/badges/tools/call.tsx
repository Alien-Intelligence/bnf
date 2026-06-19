"use client"

// components/badges/tools/call.tsx
// BadgeToolCall — the uniform tool-call block used for every (non-mutation)
// agent tool, following the Alien × BnF chat design:
//   • top    — leading icon + tool name (dotted, mono) + "via MCP",
//              with a status PILL on the right (running → terminé / échec)
//   • body   — the input params as a key/value table (query, type, …)
//
// No result-count line: a reliable count isn't available across every tool/MCP
// route, so state is conveyed by the pill alone. Corpus add/remove use the
// +N/−N count pill instead (components/badges/tools/mutation-pill.tsx).

import { Search, Wrench } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { deriveToolKey, toolSource } from "@/lib/tools/display"

interface Props {
  toolName: string
  /** Parsed tool input (null until tool-call-end). */
  input: Record<string, unknown> | null
  running: boolean
  isError: boolean
}

// Render one param value compactly: strings quoted, scalars as-is, objects as
// compact JSON. Long values are truncated by the row's `truncate`.
function formatValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function StatusPill({ running, isError }: { running: boolean; isError: boolean }) {
  const t = useTranslations("tools.parts")
  const tone = running
    ? "border-info/30 bg-info/10 text-info"
    : isError
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-brand-teal/30 bg-brand-teal/10 text-brand-teal"
  const label = running ? t("running") : isError ? t("failed") : t("done")
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] tracking-wide uppercase",
        tone,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full bg-current", running && "animate-bnf-blink")}
        aria-hidden
      />
      {label}
    </span>
  )
}

export function BadgeToolCall({ toolName, input, running, isError }: Props) {
  const t = useTranslations("tools.parts")
  const source = toolSource(toolName)
  const label = deriveToolKey(toolName, source)
  const isSearch = /search/i.test(toolName)
  const Icon = isSearch ? Search : Wrench

  const entries =
    input != null ? Object.entries(input).filter(([, v]) => v !== undefined) : []

  return (
    <div className="animate-bnf-up rounded-md border bg-card px-3 py-2.5 font-mono text-[11.5px]">
      {/* Top: icon + name + source, status pill on the right */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-brand-teal">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate font-semibold">{label}</span>
          {source === "mcp" && (
            <span className="shrink-0 text-muted-foreground">{t("viaMcp")}</span>
          )}
        </div>
        <StatusPill running={running} isError={isError} />
      </div>

      {/* Body: param key/value table. Auto-sized key column (sizes to the
          widest key) + a flexible value column that truncates — avoids the
          fixed-width overlap when keys are long (e.g. maximum_records). */}
      {entries.length > 0 && (
        <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <span className="whitespace-nowrap text-muted-foreground">{key}</span>
              <span className="min-w-0 truncate text-foreground/90">
                {formatValue(value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
