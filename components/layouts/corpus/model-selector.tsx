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

import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AGENT_AVAILABLE_MODELS } from "@/lib/constants"

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

  // base-ui's <Select.Value> renders the selected item's LABEL (not the raw id)
  // when Root receives an `items` map. Build it from the allow-list so the
  // trigger shows the translated name.
  const items: Record<string, string> = Object.fromEntries(
    AGENT_AVAILABLE_MODELS.map((m) => [m.id, t(m.labelKey)]),
  )

  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next)
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("label")}
        className="max-w-[11.5rem] font-mono text-[11px]"
      >
        <SelectValue />
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
