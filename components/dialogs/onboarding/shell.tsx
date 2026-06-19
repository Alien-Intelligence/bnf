"use client"

// components/dialogs/onboarding/shell.tsx
// DialogOnboardingShell — the shared guided-intro dialog chrome: a teal-gradient
// header (glyph + mono tag + title + lead), a list of icon points, and a single
// "J'ai compris" action. Corpus and research intros pass their own content.
// Mirrors the prototype intro overlay (design/.dc.html lines 827-854).

import Image from "next/image"
import { ArrowRight } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

export interface OnboardingPoint {
  icon: LucideIcon
  title: string
  text: string
}

interface DialogOnboardingShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tag: string
  title: string
  lead: string
  points: OnboardingPoint[]
}

export function DialogOnboardingShell({
  open,
  onOpenChange,
  tag,
  title,
  lead,
  points,
}: DialogOnboardingShellProps) {
  const tCommon = useTranslations("common")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-135 gap-0 overflow-hidden p-0">
        <DialogHeader className="gap-2 border-b bg-linear-to-b from-brand-teal/9 to-card px-6 pb-4.5 pt-5.5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7.5 items-center justify-center rounded-lg border border-brand-teal/35 bg-primary/20">
              <Image src="/brand/glyph-w.svg" alt="" width={19} height={27} priority className="h-3.5 w-auto" />
            </span>
            <span className="mono-eyebrow text-brand-teal">{tag}</span>
          </div>
          <DialogTitle className="text-[21px] font-semibold tracking-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="text-[13.5px] leading-relaxed">
            {lead}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 py-5">
          {points.map(({ icon: Icon, title: pTitle, text }) => (
            <div key={pTitle} className="flex items-start gap-3.5">
              <span className="flex size-8.5 shrink-0 items-center justify-center rounded-[9px] border border-brand-teal/25 bg-brand-teal/11 text-brand-teal">
                <Icon className="size-4" strokeWidth={1.8} />
              </span>
              <div className="min-w-0 flex-1 pt-px">
                <p className="text-[13.5px] font-semibold text-foreground">{pTitle}</p>
                <p className="mt-0.5 text-[12.5px] leading-normal text-muted-foreground">
                  {text}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end px-6 pb-5">
          <Button onClick={() => onOpenChange(false)}>
            {tCommon("gotIt")}
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
