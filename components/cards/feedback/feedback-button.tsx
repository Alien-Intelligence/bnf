"use client"

// components/cards/feedback/feedback-button.tsx
// Small trigger that opens the shared FeedbackDialog for one (target, targetId).
// Reused by all three placements: session header, assistant turn footer, and
// the open-note header. Owns its own open state.
//
// State-aware: reads the caller's existing feedback for this target (from the
// shared useMyFeedback cache) and, when present, shows the rating and opens the
// dialog prefilled to EDIT — there is one row per target, never a duplicate.

import { useState } from "react"
import { Star } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FeedbackDialog } from "@/components/dialogs/feedback/feedback-dialog"
import { useFeedbackForTarget } from "@/hooks/api/feedback"
import type { FeedbackRating, FeedbackTarget } from "@/models/feedback/schema"

interface FeedbackButtonProps {
  projectId: string
  target: FeedbackTarget
  targetId: string
  className?: string
}

export function FeedbackButton({
  projectId,
  target,
  targetId,
  className,
}: FeedbackButtonProps) {
  const t = useTranslations("feedback")
  const [open, setOpen] = useState(false)
  const existing = useFeedbackForTarget(projectId, target, targetId)
  const rated = existing != null
  const rating = existing?.rating as FeedbackRating | undefined

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title={rated ? t("editTitle") : t("button")}
        aria-label={rated ? t("editTitle") : t("button")}
        className={cn(
          "h-7 gap-1.5 border-brand-teal/40 text-[11.5px] text-brand-teal hover:bg-brand-teal/10 hover:text-brand-teal",
          rated && "bg-brand-teal/15",
          className,
        )}
      >
        <Star
          className={cn("size-3.5", rated && "fill-current")}
          strokeWidth={1.8}
          aria-hidden
        />
        {rated && rating ? t(`rating.${rating}`) : t("button")}
      </Button>
      <FeedbackDialog
        projectId={projectId}
        target={target}
        targetId={targetId}
        open={open}
        onOpenChange={setOpen}
        initialRating={rating}
        initialComment={existing?.comment ?? null}
      />
    </>
  )
}
