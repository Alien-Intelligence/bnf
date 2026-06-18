"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useTurnStream } from "@/hooks/api/turn-stream"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2 } from "lucide-react"

interface LayoutCorpusChatProps {
  appSessionId: string
}

export function LayoutCorpusChat({ appSessionId }: LayoutCorpusChatProps) {
  const t = useTranslations("corpus.chat")
  const tCommon = useTranslations("common")
  const stream = useTurnStream(appSessionId)
  const [draft, setDraft] = useState("")

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!draft.trim() || stream.isStreaming) return
    const text = draft
    setDraft("")
    await stream.post(text).catch(() => {
      // error surfaced via stream.error
    })
  }

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle>{t("headerTitle")}</CardTitle>
        <CardDescription>{t("headerSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 overflow-auto flex flex-col gap-2">
        {stream.messages.length === 0 && !stream.isStreaming ? (
          <div className="text-sm text-muted-foreground p-4">{t("systemPromptIntro")}</div>
        ) : (
          stream.messages.map((m) => (
            <div
              key={m.id}
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
          ))
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
