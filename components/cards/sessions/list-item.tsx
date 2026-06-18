"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { AppSession } from "@/models/sessions/schema"

interface CardSessionListItemProps {
  session: AppSession
  isActive: boolean
  onClick: () => void
  onRename?: (newTitle: string) => void
  onArchive?: () => void
}

export function CardSessionListItem({
  session,
  isActive,
  onClick,
  onRename,
  onArchive,
}: CardSessionListItemProps) {
  const t = useTranslations("sessions.list")
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(session.title)
  const [menuOpen, setMenuOpen] = useState(false)

  const relativeTime = formatRelative(session.updatedAt)

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== session.title) {
      onRename?.(trimmed)
    }
    setIsRenaming(false)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleRenameSubmit()
    if (e.key === "Escape") {
      setRenameValue(session.title)
      setIsRenaming(false)
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!isRenaming) onClick()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          if (!isRenaming) onClick()
        }
      }}
      className={`group relative flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer transition-colors select-none ${
        isActive
          ? "bg-primary/10 text-primary font-medium"
          : "hover:bg-muted text-foreground"
      }`}
    >
      <div className="flex-1 min-w-0">
        {isRenaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-transparent border-b border-primary outline-none text-sm"
          />
        ) : (
          <span className="block truncate">{session.title}</span>
        )}
        <span className="block text-xs text-muted-foreground mt-0.5">
          {relativeTime}
        </span>
      </div>

      {/* Context menu trigger — only show on hover */}
      {!isRenaming && (onRename ?? onArchive) && (
        <div className="relative opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            aria-label="Actions"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            ⋮
          </button>

          {menuOpen && (
            <>
              {/* Backdrop to close menu on outside click */}
              <div
                className="fixed inset-0 z-40"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                }}
              />
              <div className="absolute right-0 top-7 z-50 min-w-[120px] rounded-md border bg-popover shadow-md py-1">
                {onRename && (
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      setRenameValue(session.title)
                      setIsRenaming(true)
                    }}
                  >
                    {t("rename")}
                  </button>
                )}
                {onArchive && (
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-sm text-destructive hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      onArchive()
                    }}
                  >
                    {t("archive")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date
  const now = Date.now()
  const diff = now - d.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return "à l'instant"
  if (diff < hour) return `il y a ${Math.floor(diff / minute)} min`
  if (diff < day) return `il y a ${Math.floor(diff / hour)} h`
  if (diff < 7 * day) return `il y a ${Math.floor(diff / day)} j`
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })
}
