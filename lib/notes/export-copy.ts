"use client"

// lib/notes/export-copy.ts
// The low-OCR strings every Markdown export of a note needs (plan D13,
// feedback 2026-09-29 #7): BnF's disclaimer and the marker after a low
// citation's link, in the UI's current locale. One hook so the Atelier, the
// in-espace Carnet and the standalone Carnet cannot drift apart.

import { useTranslations } from "next-intl"
import type { ExportCopy } from "./export"

export function useNoteExportCopy(): ExportCopy {
  const t = useTranslations("citations.ocr")
  return { disclaimer: t("disclaimer"), lowMarker: t("exportLowMarker") }
}
