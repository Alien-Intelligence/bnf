"use client"

// components/layouts/corpus/chat.tsx
// The corpus/research chat panel. Renders the SDK chat handle's `turns` directly
// (rather than via <ChatPanel>) so we control two things the SDK doesn't expose:
//   1. scroll — stick to the bottom ONLY when the user is already there; never
//      yank them down while they've scrolled up to read.
//   2. thinking — a custom collapsible "Réflexion · Ns" box with a live timer +
//      spinner so a long reasoning pass never looks stuck.
// Streaming still lives entirely in the chat handle (stream.chat); this is a
// pure view over it.

import { useEffect, useMemo, useRef, useState } from "react"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { ArrowUp, ChevronDown, Loader2, Search, Sparkles, Square } from "lucide-react"
import { useThinkingExpanded } from "@/components/providers/thinking"
import type { UseChatReturn } from "@alien/chat-sdk/react"
import type {
  AgentPart,
  AssistantTurn,
  ChatTurn,
  NoticeTurn,
  ToolPartEntry,
} from "@alien/chat-sdk"
import type { UseTurnStreamResult, StreamDomainEvent } from "@/hooks/api/turn-stream"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { BadgeToolCall } from "@/components/badges/tools/call"
import { BadgeToolMutation } from "@/components/badges/tools/mutation-pill"
import { BadgeToolRemoveFilter } from "@/components/badges/tools/remove-filter-pill"
import { BadgeNoteProgress } from "@/components/badges/tools/note-progress"
import { CardToolAskUser } from "@/components/cards/tools/ask-user"
import {
  corpusRemoveByFilterView,
  isCorpusMutationTool,
  isCorpusRemoveByFilterTool,
  isNoteWriteTool,
  mutationCount,
  mutationDuplicates,
  toolCallErrored,
} from "@/lib/tools/display"
import { StreamingMarkdown } from "./streaming-markdown"
import { ModelSelector } from "./model-selector"
import { EventMemoryRow } from "@/components/events/agent/memory-event"
import { EventIngestRow } from "@/components/events/agent/ingest-event"
import { FeedbackButton } from "@/components/cards/feedback/feedback-button"
import type { AgentProvider } from "@/lib/constants"

interface LayoutCorpusChatProps {
  /** Turn-stream handle (a thin adapter over the SDK's useChat). Lifted to the
   *  parent so it can observe domain events without a second connection. */
  stream: UseTurnStreamResult
  projectId: string
  locale: string
  /** Active durable session id — anchors the session-level feedback button in
   *  the header. Null while no session is selected (button hidden). */
  appSessionId?: string | null
  /** Optional agent-copy overrides so the research atelier reuses this panel. */
  headerTitle?: string
  headerSubtitle?: string
  introText?: string
  placeholder?: string
  /** Active agent provider. The model selector is shown ONLY under "openrouter"
   *  (under "anthropic" there is a single fixed model — nothing to switch). */
  agentProvider?: AgentProvider
  /** Currently-selected model id and its setter (openrouter only). Required for
   *  the selector to render; ignored under the anthropic provider. */
  selectedModel?: string
  onModelChange?: (id: string) => void
}

/** The Alien glyph avatar shown beside every agent turn. */
function AgentAvatar() {
  return (
    <span className="flex size-6.5 shrink-0 items-center justify-center rounded-full border border-brand-teal/30 bg-primary/20">
      <Image src="/brand/glyph-w.svg" alt="" width={19} height={27} className="h-3 w-auto opacity-90" />
    </span>
  )
}

/** Three blinking teal dots — the agent "typing" indicator. */
function TypingDots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      <span className="size-1.5 animate-bnf-blink rounded-full bg-brand-teal" />
      <span className="size-1.5 animate-bnf-blink rounded-full bg-brand-teal [animation-delay:0.2s]" />
      <span className="size-1.5 animate-bnf-blink rounded-full bg-brand-teal [animation-delay:0.4s]" />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Thinking box — collapsible, dashed, with a live elapsed-seconds timer.
// `active` is true while the model is still reasoning (this thinking part is the
// last part of a streaming turn). The timer ticks while active and freezes when
// reasoning ends; historical (reloaded) thinking shows no seconds (unknown).
// ---------------------------------------------------------------------------

function ThinkingBox({ text, active }: { text: string; active: boolean }) {
  const t = useTranslations("corpus.chat")
  // Expanded/collapsed is an app-wide preference, not per-box: toggling any
  // thinking block toggles them all (like Claude Code). See ThinkingProvider.
  const { expanded: open, toggle } = useThinkingExpanded()
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active) return
    if (startRef.current === null) startRef.current = Date.now()
    const tick = () =>
      setElapsed(Math.max(0, Math.round((Date.now() - (startRef.current ?? Date.now())) / 1000)))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [active])

  return (
    <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        {active ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-brand-teal" aria-hidden />
        ) : (
          <Sparkles className="size-3.5 shrink-0 text-brand-teal/70" aria-hidden />
        )}
        <span className="text-[12px] font-medium text-foreground/80">
          {active ? t("thinkingActive") : t("thinkingDone")}
        </span>
        {elapsed > 0 && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            · {t("thinkingSeconds", { count: elapsed })}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div className="mt-2 border-l-2 pl-3 text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool part dispatch — ask_user chooser / mutation pill / uniform block.
// ---------------------------------------------------------------------------

function ToolPartView({
  tool,
  chat,
  activeAskUserId,
}: {
  tool: ToolPartEntry
  chat: UseChatReturn
  activeAskUserId: string | null
}) {
  if (tool.toolName === "ask_user") {
    return (
      <CardToolAskUser
        input={tool.input}
        disabled={chat.isStreaming}
        superseded={tool.toolUseId !== activeAskUserId}
        onSubmit={(text) => void chat.sendMessage(text)}
      />
    )
  }
  // A BnF-MCP soft failure (Gallica 403/429/…) comes back as a transport
  // success with `isError` unset — so derive the error state from the result
  // envelope too, not the SDK flag alone. See lib/tools/display.toolCallErrored.
  const errored = toolCallErrored(tool.isError, tool.result)
  const mutation = isCorpusMutationTool(tool.toolName)
  if (mutation) {
    return (
      <BadgeToolMutation
        kind={mutation}
        count={mutationCount(tool.result)}
        duplicates={mutationDuplicates(tool.result)}
        running={tool.running}
        isError={errored}
      />
    )
  }
  // Bulk remove-by-filter has its own pill: a dry-run is a preview (nothing
  // removed), a commit is the amber −N pill — distinct states, so it can't reuse
  // the add/remove mutation pill.
  if (isCorpusRemoveByFilterTool(tool.toolName)) {
    return (
      <BadgeToolRemoveFilter
        view={corpusRemoveByFilterView(tool.result)}
        running={tool.running}
        isError={errored}
      />
    )
  }
  // A note's body streams in as the tool input — show live progress while it
  // does, then fall through to the uniform block once the write lands.
  const noteWrite = isNoteWriteTool(tool.toolName)
  if (noteWrite && tool.running) {
    return <BadgeNoteProgress kind={noteWrite} startedAt={tool.startedAt} />
  }
  return (
    <BadgeToolCall
      toolName={tool.toolName}
      input={tool.input}
      running={tool.running}
      isError={errored}
    />
  )
}

function DomainPartView({
  event,
  projectId,
  locale,
}: {
  event: StreamDomainEvent
  projectId: string
  locale: string
}) {
  // Corpus mutations render from their tool part (the +N/−N pill), so the
  // corpus_event row is suppressed to avoid doubling the count.
  if (event.type === "corpus_event") return null
  if (event.type === "memory_event") {
    return <EventMemoryRow kind={event.data.kind} section={event.data.section} />
  }
  if (event.type === "ingest_event") {
    return (
      <EventIngestRow
        status={event.data.status ?? event.data.kind}
        jobId={event.data.jobId}
        projectLocaleHref={`/${locale}/projects/${projectId}/ingerer`}
      />
    )
  }
  return null
}

// One assistant part (text / thinking / tool / domain). `active` flags the
// last part of a streaming turn so the thinking timer runs.
function PartView({
  part,
  active,
  chat,
  projectId,
  locale,
  activeAskUserId,
}: {
  part: AgentPart
  active: boolean
  chat: UseChatReturn
  projectId: string
  locale: string
  activeAskUserId: string | null
}) {
  if (part.kind === "text") {
    if (!part.text) return null
    return <StreamingMarkdown content={part.text} streaming={false} />
  }
  if (part.kind === "thinking") {
    if (!part.text) return null
    return <ThinkingBox text={part.text} active={active} />
  }
  if (part.kind === "tool") {
    return <ToolPartView tool={part.tool} chat={chat} activeAskUserId={activeAskUserId} />
  }
  if (part.kind === "domain") {
    return (
      <DomainPartView
        event={part.event as StreamDomainEvent}
        projectId={projectId}
        locale={locale}
      />
    )
  }
  return null
}

function AssistantTurnView({
  turn,
  chat,
  projectId,
  locale,
  thinkingLabel,
  activeAskUserId,
  isLast,
}: {
  turn: AssistantTurn
  chat: UseChatReturn
  projectId: string
  locale: string
  thinkingLabel: string
  activeAskUserId: string | null
  isLast: boolean
}) {
  const lastIndex = turn.parts.length - 1
  const hasText = turn.parts.some((p) => p.kind === "text" && p.text.trim().length > 0)
  const showFeedback = !turn.streaming && !turn.error && hasText

  return (
    <div className="group animate-bnf-up relative pl-9">
      <span className="absolute top-0.5 left-0">
        <AgentAvatar />
      </span>
      <div className="flex min-w-0 flex-col gap-2 pt-0.5">
        {turn.parts.map((part, i) => (
          <PartView
            key={i}
            part={part}
            active={turn.streaming && i === lastIndex && part.kind === "thinking"}
            chat={chat}
            projectId={projectId}
            locale={locale}
            activeAskUserId={activeAskUserId}
          />
        ))}
        {turn.streaming && !hasText && (
          <div className="flex items-center gap-2.5">
            <TypingDots />
            <span className="font-mono text-[11.5px] text-muted-foreground">{thinkingLabel}</span>
          </div>
        )}
        {turn.error && (
          <div className="text-[12px] text-destructive">{turn.error}</div>
        )}
        {/* Feedback on a completed assistant turn — a hover-revealed action row
            (always shown on the latest turn). turn.id is the durable Message.id
            the feedback row anchors to. */}
        {showFeedback && (
          <div
            className={cn(
              "-ml-1.5 transition-opacity",
              isLast
                ? "opacity-100"
                : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            <FeedbackButton projectId={projectId} target="turn" targetId={turn.id} />
          </div>
        )}
      </div>
    </div>
  )
}

function NoticePill({ turn }: { turn: NoticeTurn }) {
  const tone =
    turn.level === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : turn.level === "warn"
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-border bg-muted/40 text-muted-foreground"
  return (
    <div className="flex justify-center">
      <span className={cn("rounded-full border px-3 py-1 text-[11px]", tone)}>
        {turn.text}
      </span>
    </div>
  )
}

export function LayoutCorpusChat({
  stream,
  projectId,
  locale,
  appSessionId,
  headerTitle,
  headerSubtitle,
  introText,
  placeholder,
  agentProvider,
  selectedModel,
  onModelChange,
}: LayoutCorpusChatProps) {
  const t = useTranslations("corpus.chat")
  const chat = stream.chat

  // Only ONE ask_user is interactive at a time: the most recent one with no
  // user reply after it. Every earlier ask_user renders as superseded (inert),
  // so answering the latest can't "kill" a still-active older chooser.
  const activeAskUserId = useMemo(() => {
    let lastId: string | null = null
    let answered = false
    for (const turn of chat.turns) {
      if (turn.role === "assistant") {
        for (const p of turn.parts) {
          if (p.kind === "tool" && p.tool.toolName === "ask_user") {
            lastId = p.tool.toolUseId
            answered = false
          }
        }
      } else if (turn.role === "user" && lastId) {
        answered = true
      }
    }
    return answered ? null : lastId
  }, [chat.turns])

  const scrollRef = useRef<HTMLDivElement>(null)
  // Pinned to the bottom? Updated on user scroll; drives whether new content
  // auto-scrolls. Starts true so the first paint lands at the bottom.
  const stickRef = useRef(true)

  // Track whether the user is near the bottom of the scroll area.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  // After every render (content streams in), keep pinned ONLY if the user is at
  // the bottom. No dependency array: runs each paint, cheap (one property read).
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  })

  function pinToBottom() {
    stickRef.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="space-y-0.5">
            <div className="text-sm font-semibold">{headerTitle ?? t("headerTitle")}</div>
            <div className="text-xs text-muted-foreground">{headerSubtitle ?? t("headerSubtitle")}</div>
          </div>
          {/* Session-level feedback sits right after the title. */}
          {appSessionId && (
            <FeedbackButton
              projectId={projectId}
              target="session"
              targetId={appSessionId}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Selector shows ONLY under openrouter, and only when the parent
              supplies controlled model state (the inline null checks also let
              TS narrow value/onChange to non-optional). */}
          {agentProvider === "openrouter" && selectedModel != null && onModelChange != null && (
            <ModelSelector
              value={selectedModel}
              onChange={onModelChange}
              disabled={chat.isStreaming}
            />
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 font-mono text-[10.5px] text-info">
            <span className="size-1.5 rounded-full bg-info" aria-hidden />
            {t("connected")}
          </span>
        </div>
      </div>

      {/* Scroll area */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {chat.turns.length === 0 ? (
          <div className="text-sm text-muted-foreground">{introText ?? t("systemPromptIntro")}</div>
        ) : (
          chat.turns.map((turn: ChatTurn, turnIdx: number) => {
            if (turn.role === "user") {
              return (
                <div key={turn.id} className="flex justify-end">
                  <div className="animate-bnf-up max-w-[88%] rounded-[14px_14px_4px_14px] bg-secondary px-3.25 py-2.25 text-[13px] leading-normal whitespace-pre-wrap text-foreground">
                    {turn.text}
                  </div>
                </div>
              )
            }
            if (turn.role === "notice") {
              return <NoticePill key={turn.id} turn={turn} />
            }
            return (
              <AssistantTurnView
                key={turn.id}
                turn={turn}
                chat={chat}
                projectId={projectId}
                locale={locale}
                thinkingLabel={t("thinking")}
                activeAskUserId={activeAskUserId}
                isLast={turnIdx === chat.turns.length - 1}
              />
            )
          })
        )}
      </div>

      {/* Composer */}
      <CorpusComposer
        chat={chat}
        onSent={pinToBottom}
        onCancel={stream.cancel}
        placeholder={placeholder ?? t("placeholder")}
        sendLabel={t("send")}
        stopLabel={t("stop")}
      />
    </div>
  )
}

/** BnF's search-style composer, driven by the SDK chat handle. */
function CorpusComposer({
  chat,
  onSent,
  onCancel,
  placeholder,
  sendLabel,
  stopLabel,
}: {
  chat: UseChatReturn
  onSent: () => void
  /** Stop the in-flight turn: aborts the client stream AND cancels the detached
   *  server turn (see useTurnStream.cancel). */
  onCancel: () => void
  placeholder: string
  sendLabel: string
  stopLabel: string
}) {
  const canSend = chat.input.trim().length > 0 && !chat.isStreaming
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSend) return
    void chat.sendMessage()
    onSent()
  }

  // Esc stops an in-flight turn (like Claude Code). Bound to the window — the
  // composer input is disabled while streaming, so it can't receive the key —
  // and only while streaming, so Esc stays free for dialogs/sheets otherwise.
  useEffect(() => {
    if (!chat.isStreaming) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [chat.isStreaming, onCancel])
  return (
    <div className="border-t p-3">
      <form
        onSubmit={onSubmit}
        className="flex items-end gap-2 rounded-lg border border-input bg-card py-1.5 pr-1.5 pl-3"
      >
        <Search className="mb-2 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          value={chat.input}
          onChange={(e) => chat.setInput(e.target.value)}
          placeholder={placeholder}
          disabled={chat.isStreaming}
          className="flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        {chat.isStreaming ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label={stopLabel}
            title={stopLabel}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground transition-colors hover:bg-secondary/70"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label={sendLabel}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
              canSend
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-secondary text-muted-foreground",
            )}
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </form>
    </div>
  )
}
