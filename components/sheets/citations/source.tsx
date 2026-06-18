"use client"

import Image from "next/image"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ExternalLink } from "lucide-react"
import { iiifImageUrl, gallicaItemUrl, iiifManifestUrl } from "@/lib/citations/external"
import { useCitationsForArk } from "@/hooks/api/citations"
import { useTranslations } from "next-intl"

interface SheetCitationSourceProps {
  projectId: string
  ark: string | null
  folio: number | null
  label: string | null
  open: boolean
  onOpenChange: (o: boolean) => void
}

export function SheetCitationSource({
  projectId,
  ark,
  folio,
  label,
  open,
  onOpenChange,
}: SheetCitationSourceProps) {
  const t = useTranslations("citations.panel")
  const { data: usages } = useCitationsForArk(projectId, ark)

  const imageUrl =
    ark && folio != null ? iiifImageUrl(ark, folio, "1200,") : null
  const gallicaUrl =
    ark && folio != null ? gallicaItemUrl(ark, folio) : null
  const manifest = ark ? iiifManifestUrl(ark) : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[480px] max-w-full flex flex-col gap-4 overflow-y-auto"
      >
        <SheetHeader>
          <SheetTitle>{label ?? t("title")}</SheetTitle>
        </SheetHeader>

        {imageUrl && (
          <div className="relative aspect-[3/4] w-full rounded overflow-hidden border">
            <Image
              src={imageUrl}
              alt={label ?? "Page"}
              fill
              className="object-contain"
              sizes="480px"
            />
          </div>
        )}

        {ark && (
          <p className="font-mono text-xs text-muted-foreground break-all">
            {ark}
          </p>
        )}

        <div className="flex flex-col gap-2">
          {gallicaUrl && (
            <a
              href={gallicaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              {t("openGallica")}
            </a>
          )}
          {manifest && (
            <a
              href={manifest}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              {t("manifest")}
            </a>
          )}
          {imageUrl && (
            <a
              href={imageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              {t("openIiif")}
            </a>
          )}
        </div>

        {usages && usages.length > 1 && (
          <>
            <Separator />
            <div>
              <p className="text-sm font-medium mb-2">{t("usages")}</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                {usages.map((u) => (
                  <li key={u.noteId} className="truncate">
                    {u.noteTitle}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
