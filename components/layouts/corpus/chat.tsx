"use client"

// components/layouts/corpus/chat.tsx
// 40%-column chat panel for the Constituer workspace.
//
// Slice 1: wraps chat-sdk's <ChatPanel> with the project's chrome (Card shell,
// French header, BnF palette). No tool-result chips, no corpus event rendering,
// no domain-specific Composer slot — those land in slice 3.
//
// RISK §13.3 (slice 2.5): if <ChatPanel> proves wholly opinionated and cannot
// be themed to fit the BnF surface without a full rewrite, the outer Card shell
// will be kept and ChatPanel's internals replaced with a custom composer+message
// list. See ai-memories/tech/repos/bnf/persistence-architecture/research/
// chat-sdk-internals.md for the tee-able runner approach.
import { useChat, ChatPanel } from "@alien/chat-sdk/react"
import "@alien/chat-sdk/react/styles.css"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { useTranslations } from "next-intl"

interface LayoutCorpusChatProps {
  projectId: string
}

export function LayoutCorpusChat({ projectId: _projectId }: LayoutCorpusChatProps) {
  const t = useTranslations("corpus.chat")
  const chat = useChat({ endpoint: "/api/chat", mode: "claude" })

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="shrink-0">
        <CardTitle>{t("headerTitle")}</CardTitle>
        <CardDescription>{t("headerSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <ChatPanel chat={chat} showModeToggle={false} />
      </CardContent>
    </Card>
  )
}
