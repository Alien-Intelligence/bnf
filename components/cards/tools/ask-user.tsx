"use client"

// components/cards/tools/ask-user.tsx
// CardToolAskUser — renders the `ask_user` tool call as an interactive
// multiple-choice chooser (design: the "askUser / EN ATTENTE" card). The agent
// ends its turn after calling ask_user; the user picks options here and clicks
// Valider, which composes their answers into the next user message.
//
// Client component: owns selection state and submits via the chat handle.

import { useMemo, useState } from "react"
import { ArrowRight, CircleHelp } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

interface AskOption {
  label: string
  description?: string
}
interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOption[]
}

interface Props {
  /** Parsed `ask_user` tool input. */
  input: Record<string, unknown> | null
  /** Send the composed answers as the next user message. */
  onSubmit: (text: string) => void
  /** Disable interaction (e.g. a turn is streaming). */
  disabled?: boolean
}

// Tolerant parse of the tool input into a typed question list.
function parseInput(input: Record<string, unknown> | null): {
  intro?: string
  questions: AskQuestion[]
} {
  if (!input || typeof input !== "object") return { questions: [] }
  const intro = typeof input.intro === "string" ? input.intro : undefined
  const rawQs = Array.isArray(input.questions) ? input.questions : []
  const questions: AskQuestion[] = []
  for (const q of rawQs) {
    if (!q || typeof q !== "object") continue
    const qq = q as Record<string, unknown>
    if (typeof qq.question !== "string") continue
    const opts = Array.isArray(qq.options) ? qq.options : []
    const options: AskOption[] = []
    for (const o of opts) {
      if (o && typeof o === "object" && typeof (o as Record<string, unknown>).label === "string") {
        const oo = o as Record<string, unknown>
        options.push({
          label: oo.label as string,
          description: typeof oo.description === "string" ? oo.description : undefined,
        })
      }
    }
    if (options.length === 0) continue
    questions.push({
      question: qq.question,
      header: typeof qq.header === "string" ? qq.header : undefined,
      multiSelect: qq.multiSelect === true,
      options,
    })
  }
  return { intro, questions }
}

export function CardToolAskUser({ input, onSubmit, disabled = false }: Props) {
  const t = useTranslations("askUser")
  const { intro, questions } = useMemo(() => parseInput(input), [input])

  // Chosen option labels keyed by question index. A map (not a positional
  // array) so it can't desync from `questions` when the tool input streams in
  // late — `selected[i]` defaults to [] for any index.
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [submitted, setSubmitted] = useState(false)
  // Escape hatch: the user dismissed the chooser to reply in their own words.
  const [skipped, setSkipped] = useState(false)

  if (questions.length === 0) return null

  const answeredCount = questions.filter(
    (_, i) => (selected[i]?.length ?? 0) > 0,
  ).length
  const allAnswered = answeredCount === questions.length
  const locked = submitted || skipped || disabled

  function toggle(qIndex: number, label: string, multi: boolean) {
    if (locked) return
    setSelected((prev) => {
      const cur = prev[qIndex] ?? []
      const nextForQ = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : cur.includes(label)
          ? []
          : [label]
      return { ...prev, [qIndex]: nextForQ }
    })
  }

  function submit() {
    if (!allAnswered || locked) return
    const lines = questions.map(
      (q, i) => `- ${q.question} → ${(selected[i] ?? []).join(", ")}`,
    )
    const text = [t("answersHeading"), ...lines].join("\n")
    setSubmitted(true)
    onSubmit(text)
  }

  return (
    <div
      className={cn(
        "animate-bnf-up rounded-md border bg-card px-4 py-3.5 transition-opacity",
        skipped && "opacity-60",
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 font-mono text-[11.5px] text-brand-teal">
          <CircleHelp className="size-3.5 shrink-0" aria-hidden />
          <span className="font-semibold">ask_user</span>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase",
            submitted
              ? "border-brand-teal/30 bg-brand-teal/10 text-brand-teal"
              : "border-info/30 bg-info/10 text-info",
          )}
        >
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {submitted ? t("answered") : t("pending")}
        </span>
      </div>

      {intro && (
        <p className="mt-2 text-[13px] font-semibold text-foreground">{intro}</p>
      )}

      {/* Questions */}
      <div className="mt-3 flex flex-col gap-3.5">
        {questions.map((q, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-foreground">
              {q.question}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt) => {
                const active = selected[i]?.includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => toggle(i, opt.label, q.multiSelect ?? false)}
                    disabled={locked}
                    aria-pressed={active}
                    title={opt.description}
                    className={cn(
                      "rounded-full border px-3 py-1 text-left text-[12px] transition-colors",
                      active
                        ? "border-brand-teal/50 bg-brand-teal/12 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:border-brand-teal/40 hover:text-foreground",
                      locked && "cursor-default opacity-70 hover:border-border hover:text-muted-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      {skipped ? (
        <p className="mt-3.5 text-[11.5px] text-muted-foreground">{t("freeHint")}</p>
      ) : (
        <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={submit}
            disabled={!allAnswered || locked}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
              allAnswered && !locked
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "cursor-not-allowed bg-secondary text-muted-foreground",
            )}
          >
            {t("validate")}
            <ArrowRight className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setSkipped(true)}
            disabled={disabled}
            className="text-[12px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
          >
            {t("free")}
          </button>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {t("progress", { count: answeredCount, total: questions.length })}
          </span>
        </div>
      )}
    </div>
  )
}
