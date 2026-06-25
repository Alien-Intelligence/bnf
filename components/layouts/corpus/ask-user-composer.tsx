"use client"

// components/layouts/corpus/ask-user-composer.tsx
// AskUserComposer — the `ask_user` tool taking over the composer slot, the way
// Claude Code's question panel replaces the prompt input. When the agent ends a
// turn with ask_user, the question is NOT buried in the message stream: it
// becomes the input. The user picks options here; "Valider" composes the
// selections into the next user message (so the answer reads as a normal user
// bubble afterward). Esc / "Répondre librement" dismisses the panel back to the
// free-text composer.
//
// Client component: owns selection + active-tab state and submits via the chat
// handle (the parent passes onSubmit → chat.sendMessage).

import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowRight, Check, CircleHelp, Loader2, Pencil, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
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
  /** Parsed `ask_user` tool input (null while the input is still streaming). */
  input: Record<string, unknown> | null
  /** Send the composed answers as the next user message. */
  onSubmit: (text: string) => void
  /** Dismiss the panel and fall back to the free-text composer. */
  onSkip: () => void
  /** A turn is streaming — lock interaction. */
  disabled?: boolean
  /** The tool call is still streaming its input — show the preparing skeleton
   *  rather than nothing during the tool-call-start → tool-call-end gap. */
  running?: boolean
}

// Tolerant parse of the tool input into a typed question list. Mirrors the
// schema in lib/agent/tools/interaction.ts but never throws on partial input
// (the panel can mount mid-stream before the model finishes emitting the call).
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

export function AskUserComposer({
  input,
  onSubmit,
  onSkip,
  disabled = false,
  running = false,
}: Props) {
  const t = useTranslations("askUser")
  const { intro, questions } = useMemo(() => parseInput(input), [input])

  // Chosen option labels keyed by question index (a map, not a positional array,
  // so it can't desync from `questions` if the input streams in late).
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  // Every question carries an implicit "Other" escape (like Claude Code): when
  // toggled on, the typed text is injected as the answer. Tracked separately
  // from `selected` because it's free text, not one of the offered labels.
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [active, setActive] = useState(0)
  const [submitted, setSubmitted] = useState(false)

  const isAnswered = useCallback(
    (i: number) =>
      (selected[i]?.length ?? 0) > 0 ||
      (otherOn[i] === true && (otherText[i]?.trim().length ?? 0) > 0),
    [selected, otherOn, otherText],
  )
  const answeredCount = questions.filter((_, i) => isAnswered(i)).length
  const allAnswered = questions.length > 0 && answeredCount === questions.length
  const locked = submitted || disabled

  const submit = useCallback(() => {
    if (!allAnswered || locked) return
    const lines = questions.map((q, i) => {
      const picks = [...(selected[i] ?? [])]
      const free = otherOn[i] ? otherText[i]?.trim() : undefined
      if (free) picks.push(free)
      return `- ${q.question} → ${picks.join(", ")}`
    })
    const text = [t("answersHeading"), ...lines].join("\n")
    setSubmitted(true)
    onSubmit(text)
  }, [allAnswered, locked, questions, selected, otherOn, otherText, t, onSubmit])

  // Esc dismisses the panel (answer freely); Enter submits once every question
  // is answered — keyboard parity with Claude Code's chooser. Bound to the
  // window because the panel has no focused text input to catch the keys.
  useEffect(() => {
    if (locked) return
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const inField = el?.tagName === "INPUT" || el?.tagName === "TEXTAREA"
      if (e.key === "Escape") {
        // Let the field's own handler clear/blur first; only dismiss from outside.
        if (inField) return
        e.preventDefault()
        onSkip()
      } else if (e.key === "Enter" && allAnswered && !inField) {
        e.preventDefault()
        submit()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [locked, allAnswered, onSkip, submit])

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
    // A single-select pick is exclusive — it clears the "Other" escape too.
    if (!multi) setOtherOn((prev) => ({ ...prev, [qIndex]: false }))
    // Single-select auto-advances to the next still-unanswered question — the
    // librarian flows through the tabs without reaching for the mouse.
    if (!multi && qIndex < questions.length - 1) {
      const next = questions.findIndex((_, i) => i > qIndex && !isAnswered(i))
      if (next !== -1) setActive(next)
    }
  }

  // Toggle the free-text "Other" escape. Single-select clears the picked option
  // (Other is just another exclusive choice); multi-select leaves picks intact.
  function toggleOther(qIndex: number, multi: boolean) {
    if (locked) return
    setOtherOn((prev) => {
      const next = !prev[qIndex]
      if (next && !multi) setSelected((s) => ({ ...s, [qIndex]: [] }))
      return { ...prev, [qIndex]: next }
    })
  }

  // Input still streaming in — show a preparing skeleton so the panel doesn't
  // blink into existence after a silent gap.
  if (questions.length === 0) {
    return (
      <div className="border-t p-3">
        <div className="rounded-lg border bg-card px-4 py-3.5">
          <div className="flex items-center gap-2 font-mono text-[11.5px] text-brand-teal">
            {running ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            ) : (
              <CircleHelp className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="font-semibold">{t("preparing")}</span>
          </div>
          <div className="mt-3 flex flex-col gap-2" aria-hidden>
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-9 w-full animate-pulse rounded bg-muted" />
            <div className="h-9 w-full animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>
    )
  }

  const current = questions[Math.min(active, questions.length - 1)]
  const currentIndex = Math.min(active, questions.length - 1)
  const multi = current.multiSelect ?? false

  return (
    <div className="border-t p-3">
      <div className="animate-bnf-up rounded-lg border bg-card">
        {/* Tabs — one per question (chip = header), with the close/skip control.
            A single question shows just the ask_user marker, no tab strip. */}
        <div className="flex items-center gap-1 border-b px-2 py-1.5">
          <CircleHelp className="ml-1 size-3.5 shrink-0 text-brand-teal" aria-hidden />
          {questions.length > 1 ? (
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
              {questions.map((q, i) => {
                const isActive = i === currentIndex
                const isDone = isAnswered(i)
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setActive(i)}
                    aria-current={isActive}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors",
                      isActive
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {isDone && <Check className="size-3 text-brand-teal" aria-hidden />}
                    {q.header ?? t("questionTab", { index: i + 1 })}
                  </button>
                )
              })}
            </div>
          ) : (
            <span className="flex-1 px-1 text-[11.5px] font-medium text-muted-foreground">
              {current.header ?? ""}
            </span>
          )}
          <button
            type="button"
            onClick={onSkip}
            aria-label={t("free")}
            title={t("free")}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* Question + options */}
        <div className="px-4 py-3">
          {intro && currentIndex === 0 && (
            <p className="mb-2 text-[12.5px] font-semibold text-foreground">{intro}</p>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[13px] font-medium text-foreground">{current.question}</p>
            {multi && (
              <span className="shrink-0 text-[10.5px] text-muted-foreground">{t("multiHint")}</span>
            )}
          </div>

          <div className="mt-2.5 flex flex-col gap-1.5">
            {current.options.map((opt) => {
              const isOn = selected[currentIndex]?.includes(opt.label) ?? false
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => toggle(currentIndex, opt.label, multi)}
                  disabled={locked}
                  aria-pressed={isOn}
                  className={cn(
                    "flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
                    isOn
                      ? "border-brand-teal/50 bg-brand-teal/10"
                      : "border-border bg-background hover:border-brand-teal/40 hover:bg-muted/40",
                    locked && "cursor-default opacity-70",
                  )}
                >
                  {/* Radio (single) vs. checkbox (multi) affordance. */}
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
                      multi ? "rounded-lg" : "rounded-full",
                      isOn ? "border-brand-teal bg-brand-teal text-background" : "border-muted-foreground/50",
                    )}
                    aria-hidden
                  >
                    {isOn &&
                      (multi ? (
                        <Check className="size-3" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-background" />
                      ))}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-medium text-foreground">{opt.label}</span>
                    {opt.description && (
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                        {opt.description}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}

            {/* "Other" — the free-text escape, auto-added to every question. */}
            {(() => {
              const isOn = otherOn[currentIndex] === true
              return (
                <div
                  className={cn(
                    "rounded-md border transition-colors",
                    isOn ? "border-brand-teal/50 bg-brand-teal/10" : "border-border bg-background",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleOther(currentIndex, multi)}
                    disabled={locked}
                    aria-pressed={isOn}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                      !isOn && "hover:bg-muted/40",
                      locked && "cursor-default opacity-70",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center border transition-colors",
                        multi ? "rounded-lg" : "rounded-full",
                        isOn ? "border-brand-teal bg-brand-teal text-background" : "border-muted-foreground/50",
                      )}
                      aria-hidden
                    >
                      {isOn &&
                        (multi ? (
                          <Check className="size-3" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-background" />
                        ))}
                    </span>
                    <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="text-[12.5px] font-medium text-foreground">{t("other")}</span>
                  </button>
                  {isOn && (
                    <div className="px-3 pb-2.5">
                      <Input
                        autoFocus
                        value={otherText[currentIndex] ?? ""}
                        onChange={(e) =>
                          setOtherText((prev) => ({ ...prev, [currentIndex]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && allAnswered) {
                            e.preventDefault()
                            submit()
                          }
                        }}
                        disabled={locked}
                        placeholder={t("otherPlaceholder")}
                        className="h-8 text-[12.5px]"
                      />
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        </div>

        {/* Footer — submit / progress / cancel hint */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-3 py-2">
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
          <span className="font-mono text-[11px] text-muted-foreground">
            {t("progress", { count: answeredCount, total: questions.length })}
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">{t("cancelHint")}</span>
        </div>
      </div>
    </div>
  )
}
