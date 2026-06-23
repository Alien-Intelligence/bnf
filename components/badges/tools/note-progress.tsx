"use client"

// components/badges/tools/note-progress.tsx
// BadgeNoteProgress — live progress for note_create / note_update WHILE RUNNING.
//
// Why this exists: a research note's whole body is the tool input, so the model
// streams it token by token. That can take a minute, during which the generic
// <BadgeToolCall running> sits motionless and reads as a hang. This block gives
// the same reassurance the ThinkingBox does: a pulsing icon + a live elapsed
// timer, so a long write never looks stuck.
//
// Why no character/token count: the SDK accumulates the streamed input into
// `inputText`, but this app follows DETACHED turns via snapshot/resume frames
// (the turn survives a tab close), and those frames don't carry every
// input-delta — so `inputText` lands its first chunk (~the id) then jumps to
// full only at the end. A count would sit frozen and read as broken. The
// elapsed timer is the one signal that moves reliably without a chat-sdk change.

import { useEffect, useState } from "react"
import { NotebookPen } from "lucide-react"
import { useTranslations } from "next-intl"

interface Props {
  kind: "create" | "update" | "append"
  /** Epoch ms when the tool call started (SDK ToolPartEntry.startedAt). */
  startedAt: number
}

const LABEL_KEY: Record<Props["kind"], string> = {
  create: "writing",
  update: "updating",
  append: "appending",
}

export function BadgeNoteProgress({ kind, startedAt }: Props) {
  const t = useTranslations("tools.note")
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const tick = () =>
      setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [startedAt])

  return (
    <div className="animate-bnf-up rounded-md border bg-card px-3 py-2.5 font-mono text-[11.5px]">
      <div className="flex items-center gap-2 text-brand-teal">
        <NotebookPen className="size-3.5 shrink-0 animate-pulse" aria-hidden />
        <span className="font-semibold">{t(LABEL_KEY[kind])}</span>
        {elapsed > 0 && (
          <span className="ml-auto whitespace-nowrap text-muted-foreground">
            {t("seconds", { count: elapsed })}
          </span>
        )}
      </div>
    </div>
  )
}
