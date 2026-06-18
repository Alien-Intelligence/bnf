"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { UseTurnStreamResult, StreamDomainEvent } from "@/hooks/api/turn-stream"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2 } from "lucide-react"
import { BadgeToolCall } from "@/components/badges/tools/call"
import { EventCorpusRow } from "@/components/events/agent/corpus-event"
import { EventMemoryRow } from "@/components/events/agent/memory-event"
import { EventIngestRow } from "@/components/events/agent/ingest-event"

interface LayoutCorpusChatProps {
  /**
   * The already-instantiated turn-stream handle. Lifted to the parent
   * (ConstituerClient) so the parent can observe domain events without
   * opening a second SSE connection.
   */
  stream: UseTurnStreamResult
  /** Used to build the deep-link inside EventIngestRow. */
  projectId: string
  /** Active locale (e.g. "fr"). Used to build the deep-link inside EventIngestRow. */
  locale: string
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
    return (
      <EventMemoryRow kind={event.data.kind} section={event.data.section} />
    )
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

export function LayoutCorpusChat({ stream, projectId, locale }: LayoutCorpusChatProps) {
  const t = useTranslations("corpus.chat")
  const tCommon = useTranslations("common")
  const [draft, setDraft] = useState("")

  // Show the reconnecting pill when the stream is re-establishing an existing
  // session (messages already present) rather than connecting for the first
  // time (no messages yet).
  const isReconnecting = stream.isConnecting && stream.messages.length > 0

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.trim() || stream.isStreaming) return
    const text = draft
    setDraft("")
    await stream.post(text).catch(() => {
      // error surfaced via stream.error
    })
  }

  const hasContent =
    stream.messages.length > 0 ||
    stream.toolCalls.length > 0 ||
    stream.domainEvents.length > 0 ||
    stream.isStreaming

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle>{t("headerTitle")}</CardTitle>
        <CardDescription>{t("headerSubtitle")}</CardDescription>
      </CardHeader>

      {isReconnecting && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("reconnecting")}
        </div>
      )}

      <CardContent className="flex-1 overflow-auto flex flex-col gap-2">
        {!hasContent ? (
          <div className="text-sm text-muted-foreground p-4">{t("systemPromptIntro")}</div>
        ) : (
          <>
            {stream.messages.map((m) => (
              <div key={m.id} className="flex flex-col gap-1">
                <div
                  className={`rounded-md p-2 text-sm ${
                    m.role === "user"
                      ? "bg-muted self-end max-w-[80%]"
                      : "bg-card max-w-[90%]"
                  }`}
                >
                  <div className="whitespace-pre-wrap">{m.content ?? ""}</div>
                  {m.status === "streaming" && (
                    <span className="inline-block ml-1 animate-pulse">▌</span>
                  )}
                  {m.status === "error" && (
                    <div className="mt-1 text-xs text-destructive">{m.error}</div>
                  )}
                </div>

                {/* Tool call chips for this message — grouped by messageId */}
                {m.role === "assistant" &&
                  stream.toolCalls.filter((tc) => tc.messageId === m.id).length > 0 && (
                    <div className="flex flex-wrap gap-1 px-1">
                      {stream.toolCalls
                        .filter((tc) => tc.messageId === m.id)
                        .sort(
                          (a, b) =>
                            new Date(a.createdAt).getTime() -
                            new Date(b.createdAt).getTime(),
                        )
                        .map((tc) => (
                          <BadgeToolCall
                            key={tc.id}
                            tool={tc.tool}
                            status={tc.status}
                            source={tc.source}
                            latencyMs={tc.latencyMs}
                            error={null}
                          />
                        ))}
                    </div>
                  )}
              </div>
            ))}

            {/* Domain event log — rendered chronologically after all messages.
                StreamDomainEvent has no messageId, so we cannot correlate them
                to individual assistant messages at this slice. */}
            {stream.domainEvents.length > 0 && (
              <div className="flex flex-col gap-0.5 px-1 pt-1">
                {stream.domainEvents.map((ev, idx) => (
                  // Domain events have no stable id — use index as key
                  // (list is append-only; index is stable for existing items)
                  <DomainEventRow key={idx} event={ev} projectId={projectId} locale={locale} />
                ))}
              </div>
            )}
          </>
        )}
        {stream.error && (
          <div className="text-sm text-destructive p-2">{stream.error}</div>
        )}
      </CardContent>

      <div className="border-t p-3 flex gap-2">
        <form onSubmit={onSubmit} className="flex flex-1 gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("placeholder")}
            disabled={stream.isStreaming || stream.isConnecting}
          />
          {stream.isStreaming ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => stream.cancel().catch(() => {})}
            >
              {tCommon("cancel")}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!draft.trim() || stream.isConnecting}
            >
              {stream.isConnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("send")
              )}
            </Button>
          )}
        </form>
      </div>
    </Card>
  )
}
