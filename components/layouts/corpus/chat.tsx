"use client"

import Image from "next/image"
import { useTranslations } from "next-intl"
import { ArrowUp, Loader2, Search } from "lucide-react"
import { ChatPanel } from "@alien/chat-sdk/react"
import type { UseChatReturn } from "@alien/chat-sdk/react"
import type { ToolPartEntry, UserTurn } from "@alien/chat-sdk"
import type { UseTurnStreamResult, StreamDomainEvent } from "@/hooks/api/turn-stream"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { BadgeToolCall } from "@/components/badges/tools/call"
import { StreamingMarkdown } from "./streaming-markdown"
import { EventCorpusRow } from "@/components/events/agent/corpus-event"
import { EventMemoryRow } from "@/components/events/agent/memory-event"
import { EventIngestRow } from "@/components/events/agent/ingest-event"

interface LayoutCorpusChatProps {
  /** Turn-stream handle (a thin adapter over the SDK's useChat); we render via
   *  its underlying `.chat` through the SDK `<ChatPanel>`. Lifted to the parent
   *  so it can observe domain events without a second connection. */
  stream: UseTurnStreamResult
  /** Used to build the deep-link inside EventIngestRow. */
  projectId: string
  /** Active locale (e.g. "fr"). Used to build the deep-link inside EventIngestRow. */
  locale: string
  /** Optional agent-copy overrides so the research atelier reuses this panel
   *  without showing the corpus agent's strings. Default to corpus i18n. */
  headerSubtitle?: string
  introText?: string
  placeholder?: string
}

/** The Alien glyph avatar shown beside every agent turn (prototype lines 217). */
function AgentAvatar() {
  return (
    <span className="flex size-6.5 shrink-0 items-center justify-center rounded-full border border-brand-teal/30 bg-primary/20">
      <Image src="/brand/glyph-w.svg" alt="" width={19} height={27} className="h-3 w-auto opacity-90" />
    </span>
  )
}

/** Three blinking teal dots — the agent "thinking" indicator (prototype 242-244). */
function TypingDots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      <span className="size-1.5 animate-bnf-blink rounded-full bg-brand-teal" />
      <span className="size-1.5 animate-bnf-blink rounded-full bg-brand-teal [animation-delay:0.2s]" />
      <span className="size-1.5 animate-bnf-blink rounded-full bg-brand-teal [animation-delay:0.4s]" />
    </span>
  )
}

function DomainEventRow({
  event,
  projectId,
  locale,
}: {
  event: StreamDomainEvent
  projectId: string
  locale: string
}) {
  if (event.type === "corpus_event") {
    return (
      <EventCorpusRow
        kind={event.data.kind}
        count={event.data.count}
        versionSeq={event.data.versionSeq}
      />
    )
  }
  if (event.type === "memory_event") {
    return <EventMemoryRow kind={event.data.kind} section={event.data.section} />
  }
  if (event.type === "ingest_event") {
    const status = event.data.status ?? event.data.kind
    const jobId = event.data.jobId
    return (
      <EventIngestRow
        status={status}
        jobId={jobId}
        projectLocaleHref={`/${locale}/projects/${projectId}/ingerer`}
      />
    )
  }
  return null
}

export function LayoutCorpusChat({
  stream,
  projectId,
  locale,
  headerSubtitle,
  introText,
  placeholder,
}: LayoutCorpusChatProps) {
  const t = useTranslations("corpus.chat")
  const chat = stream.chat

  return (
    <ChatPanel
      chat={chat}
      showModeToggle={false}
      className="bnf-corpus-chat overflow-hidden rounded-xl border"
      header={
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div className="space-y-0.5">
            <div className="text-sm font-semibold">{t("headerTitle")}</div>
            <div className="text-xs text-muted-foreground">{headerSubtitle ?? t("headerSubtitle")}</div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 font-mono text-[10.5px] text-info">
            <span className="size-1.5 rounded-full bg-info" aria-hidden />
            {t("connected")}
          </span>
        </div>
      }
      renderEmpty={() => (
        <div className="p-4 text-sm text-muted-foreground">{introText ?? t("systemPromptIntro")}</div>
      )}
      renderUser={(turn: UserTurn) => (
        <div className="flex justify-end">
          <div className="animate-bnf-up max-w-[88%] rounded-[14px_14px_4px_14px] bg-secondary px-3.25 py-2.25 text-[13px] leading-normal whitespace-pre-wrap text-foreground">
            {turn.text}
          </div>
        </div>
      )}
      renderAvatar={() => <AgentAvatar />}
      renderText={(text) => <StreamingMarkdown content={text} streaming={false} />}
      renderTool={(tool: ToolPartEntry) => (
        <BadgeToolCall
          tool={tool.toolName}
          status={tool.running ? "running" : tool.isError ? "error" : "ok"}
          source={tool.toolName.includes("__") ? "mcp" : "custom"}
          latencyMs={tool.endedAt != null ? tool.endedAt - tool.startedAt : null}
          error={null}
        />
      )}
      renderDomainEvent={(event) => (
        <DomainEventRow event={event as StreamDomainEvent} projectId={projectId} locale={locale} />
      )}
      renderTyping={() => (
        <div className="ml-9 flex items-center gap-2.5">
          <TypingDots />
          <span className="font-mono text-[11.5px] text-muted-foreground">{t("thinking")}</span>
        </div>
      )}
      composer={(c: UseChatReturn) => <CorpusComposer chat={c} placeholder={placeholder ?? t("placeholder")} sendLabel={t("send")} />}
    />
  )
}

/** BnF's search-style composer, driven by the SDK chat handle. */
function CorpusComposer({
  chat,
  placeholder,
  sendLabel,
}: {
  chat: UseChatReturn
  placeholder: string
  sendLabel: string
}) {
  const canSend = chat.input.trim().length > 0 && !chat.isStreaming
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSend) return
    void chat.sendMessage()
  }
  return (
    <div className="border-t p-3">
      <form
        onSubmit={onSubmit}
        className="flex items-end gap-2 rounded-lg border border-input bg-card py-1.5 pl-3 pr-1.5"
      >
        <Search className="mb-2 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          value={chat.input}
          onChange={(e) => chat.setInput(e.target.value)}
          placeholder={placeholder}
          disabled={chat.isStreaming}
          className="flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
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
          {chat.isStreaming ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </form>
    </div>
  )
}
