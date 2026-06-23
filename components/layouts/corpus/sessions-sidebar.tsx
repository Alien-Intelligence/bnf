"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { CardSessionListItem } from "@/components/cards/sessions/list-item"
import { CardMemoryBox } from "@/components/cards/memory/box"
import { DialogMemory } from "@/components/dialogs/memory"
import {
  useSessions,
  useCreateSession,
  useRenameSession,
  useArchiveSession,
} from "@/hooks/api/sessions"
import type { AppSession } from "@/models/sessions/schema"

interface LayoutSessionsSidebarProps {
  projectId: string
  scope: "corpus" | "research"
  activeSessionId: string
  onActiveSessionChange: (id: string) => void
  initialSessions?: AppSession[]
  /**
   * Research-only: the artefacts (notes) picker, rendered between the session
   * list and the memory box (prototype rail, lines 142-168). When present the
   * session list is height-capped so the picker gets the elastic space, exactly
   * as the design does for Step 3.
   */
  artefactsSlot?: React.ReactNode
}

export function LayoutSessionsSidebar({
  projectId,
  scope,
  activeSessionId,
  onActiveSessionChange,
  initialSessions,
  artefactsSlot,
}: LayoutSessionsSidebarProps) {
  const t = useTranslations("sessions.sidebar")
  const tCommon = useTranslations("common")
  const [memoryOpen, setMemoryOpen] = useState(false)

  const { data: sessions, isLoading, isError, refetch } = useSessions(
    projectId,
    scope,
    { initialData: initialSessions },
  )

  const create = useCreateSession(projectId)
  const rename = useRenameSession()
  const archive = useArchiveSession(projectId)

  // The "+" opens an unnamed session immediately and makes it active — no title
  // prompt. The session is born with a placeholder; its first message
  // auto-names it (SessionService.maybeAutoTitle), and the rename action in the
  // list item is always available.
  const onCreate = () => {
    if (create.isPending) return
    create.mutate(
      { scope },
      { onSuccess: (session) => onActiveSessionChange(session.id) },
    )
  }

  return (
    <div className="flex h-full flex-col border-r bg-sidebar">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-3.5 pb-2 pt-3.5">
        <span className="mono-eyebrow">
          {t(scope === "research" ? "titleResearch" : "titleCorpus")}
        </span>
        <button
          type="button"
          onClick={onCreate}
          disabled={create.isPending}
          title={t("newButton")}
          aria-label={t("newButton")}
          className="flex size-6 items-center justify-center rounded-md border bg-card text-neutral-300 transition-colors hover:border-brand-teal/45 hover:text-brand-teal disabled:opacity-50"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {/* List — height-capped when an artefacts picker shares the rail. */}
      <div
        className={
          artefactsSlot
            ? "max-h-[38%] shrink-0 overflow-y-auto pt-1 pb-4"
            : "flex-1 overflow-y-auto py-1"
        }
      >
        {isLoading ? (
          <div className="flex flex-col gap-1 px-2 py-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : isError ? (
          <div className="px-3 py-4 text-center">
            <p className="text-sm text-destructive mb-2">{tCommon("error")}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refetch()}
            >
              {tCommon("tryAgain")}
            </Button>
          </div>
        ) : sessions?.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground text-center">
            {t("empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5 px-1">
            {sessions?.map((session) => (
              <CardSessionListItem
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onClick={() => onActiveSessionChange(session.id)}
                onRename={(newTitle) =>
                  rename.mutate({
                    sessionId: session.id,
                    projectId,
                    scope,
                    title: newTitle,
                  })
                }
                onArchive={() =>
                  archive.mutate({ sessionId: session.id, scope })
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Research artefacts picker — elastic middle section (research only). */}
      {artefactsSlot}

      {/* Project memory — compact info box, opens the full memory dialog. */}
      <CardMemoryBox
        projectId={projectId}
        scope={scope}
        onOpen={() => setMemoryOpen(true)}
      />

      <DialogMemory
        open={memoryOpen}
        onOpenChange={setMemoryOpen}
        projectId={projectId}
        scope={scope}
      />
    </div>
  )
}
