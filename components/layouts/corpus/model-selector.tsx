"use client"

// components/layouts/corpus/model-selector.tsx
// Chat-header model picker, rendered ONLY under AGENT_PROVIDER=openrouter (the
// parent gates it — under the direct-Anthropic provider there is nothing to
// switch). Choosing a model sets it for the NEXT turn: useTurnStream attaches
// `body.model` to every request and the openrouter runner reads
// `body.model ?? cfg.model`. Choices are the curated AGENT_AVAILABLE_MODELS
// allow-list (no free text → no arbitrary spend / bad ids); labels are i18n keys
// under the `models` namespace (the raw vendor/model ids carry dots & slashes
// that collide with next-intl's key nesting, so they can't be keys themselves).
//
// Model switching is an ADVANCED affordance, so it is deliberately understated:
// the trigger is a bare robot icon while the default model is in effect, and the
// model name only appears once the user has switched AWAY from the default. The
// dropdown's trailing chevron is suppressed (the icon is the whole control).

import { Bot } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select"
import { AGENT_AVAILABLE_MODELS, AGENT_DEFAULT_MODEL } from "@/lib/constants"
import { cn } from "@/lib/utils"

interface ModelSelectorProps {
  /** Currently-selected OpenRouter model id (one of AGENT_AVAILABLE_MODELS). */
  value: string
  /** Called with the newly-selected model id. */
  onChange: (id: string) => void
  /** Disable while a turn is streaming (the change would only take effect next
   *  turn anyway — disabling avoids the impression it switches mid-stream). */
  disabled?: boolean
}

export function ModelSelector({ value, onChange, disabled }: ModelSelectorProps) {
  const t = useTranslations("models")

  const isDefault = value === AGENT_DEFAULT_MODEL
  const selected = AGENT_AVAILABLE_MODELS.find((m) => m.id === value)
  const selectedLabel = selected ? t(selected.labelKey) : value
  // Title/aria always name the active model so the icon-only state stays legible
  // to screen readers and on hover.
  const triggerLabel = `${t("label")} — ${selectedLabel}`

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next)
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label={triggerLabel}
        title={triggerLabel}
        // Suppress the trailing chevron (the trigger's last <svg> child) — the
        // robot icon is the entire control. Collapse to a square icon button
        // when the default model is active; widen to show the name otherwise.
        className={cn(
          "gap-1.5 font-mono text-[11px] text-muted-foreground [&>svg:last-child]:hidden",
          isDefault && "w-7 justify-center px-0",
        )}
      >
        <Bot className="size-4 shrink-0" aria-hidden />
        {!isDefault && <span className="max-w-40 truncate">{selectedLabel}</span>}
      </SelectTrigger>
      <SelectContent align="end">
        {AGENT_AVAILABLE_MODELS.map((m) => (
          <SelectItem key={m.id} value={m.id} className="font-mono text-[11px]">
            {t(m.labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
