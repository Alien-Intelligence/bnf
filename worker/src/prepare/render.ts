/**
 * Markdown renderers for the two prepare pipelines.
 *
 * `renderOcrMarkdown` emits one `## Folio N` heading per page so the chunker
 * can stamp the folio number onto every chunk's metadata. We trust the BnF
 * metadata for the header — see CLAUDE.md "Trust the BnF metadata".
 *
 * `renderImageMarkdown` is adapted from bnf-images/src/cluster.ts. We don't
 * import it directly because that file also exports an EntryCreatePayload
 * shape that is a Track-3 concern, and pulling it in here would couple the
 * tracks. The visual structure of the markdown should remain in sync.
 */
import type { BnfDocInfo } from "../types.js";
import type { ImagePage } from "./extract.js";
import type { ImageDescription, DocumentContext } from "./vision.js";

export interface OcrPage {
  /** 1-based page ordre as returned by Gallica's Pagination service. */
  ordre: number;
  text: string;
}

/** Build the YAML-ish header used by both pipelines. */
function renderHeader(info: BnfDocInfo): string {
  const lines: string[] = [];
  const title = info.title ?? `Document ${info.ark}`;
  lines.push(`# ${title}`);
  lines.push("");

  const meta: string[] = [];
  if (info.creator) meta.push(`**Auteur·rice :** ${info.creator}`);
  if (info.date) meta.push(`**Date :** ${info.date}`);
  if (info.docType) meta.push(`**Type :** ${info.docType}`);
  meta.push(`**ARK :** ${info.ark}`);
  if (info.pageCount !== null) meta.push(`**Pages :** ${info.pageCount}`);
  lines.push(meta.join("  \n"));
  lines.push("");
  return lines.join("\n");
}

export function renderOcrMarkdown(info: BnfDocInfo, pages: OcrPage[]): string {
  const parts: string[] = [renderHeader(info)];
  for (const page of pages) {
    const body = page.text.trim();
    if (body.length === 0) continue;
    parts.push(`## Folio ${page.ordre}`);
    parts.push("");
    parts.push(body);
    parts.push("");
  }
  return parts.join("\n");
}

/**
 * Render a list of described image canvases as one markdown body, one
 * `## Folio N` section per canvas. The chunker keys on `## Folio N` headings
 * so each chunk carries `folio: N` in its metadata automatically.
 *
 * A 1-canvas document collapses to a single section (same shape as the old
 * single-image path).
 */
export function renderImagePagesMarkdown(
  info: BnfDocInfo,
  pages: ImagePage[],
  opts: { totalCanvases: number; cappedAt: number | null },
): string {
  const parts: string[] = [renderHeader(info)];

  if (pages.length > 1 || opts.totalCanvases > 1) {
    parts.push(`**Total de canvases :** ${opts.totalCanvases}`);
    if (opts.cappedAt !== null && opts.cappedAt < opts.totalCanvases) {
      parts.push(`*Description limitée aux ${opts.cappedAt} premières images.*`);
    }
    parts.push("");
  }

  for (const page of pages) {
    parts.push(`## Folio ${page.ordre}`);
    parts.push("");
    parts.push(`**Image source :** <${page.iiifUrl}>`);
    if (page.label && page.label !== "NP") {
      parts.push(`**Légende manifeste :** ${page.label}`);
    }
    parts.push("");
    parts.push(renderImageDescriptionBody(page.description));
  }

  return parts.join("\n");
}

/**
 * Render a Holo2 description block (no header — the caller supplies that).
 * Shared between single-image and multi-image paths.
 */
function renderImageDescriptionBody(description: ImageDescription): string {
  const lines: string[] = [];

  lines.push("### Type visuel");
  lines.push(description.typeVisuel);
  lines.push("");

  if (description.titreApparent) {
    lines.push("### Titre lisible");
    lines.push(description.titreApparent);
    lines.push("");
  }

  lines.push("### Sujet");
  lines.push(description.sujet);
  lines.push("");

  lines.push("### Description");
  lines.push(description.descriptionLongue);
  lines.push("");

  if (description.scenesEtElements.length > 0) {
    lines.push("### Scènes et éléments");
    for (const el of description.scenesEtElements) lines.push(`- ${el}`);
    lines.push("");
  }

  if (description.legendes.length > 0) {
    lines.push("### Inscriptions et légendes");
    for (const l of description.legendes) lines.push(`- ${l}`);
    lines.push("");
  }

  if (description.echelle) {
    lines.push("### Échelle");
    lines.push(description.echelle);
    lines.push("");
  }

  if (description.motsCles.length > 0) {
    lines.push("### Mots-clés");
    lines.push(description.motsCles.join(", "));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Legacy single-image renderer — kept for back-compat with anything still
 * calling it directly. Prefer `renderImagePagesMarkdown` for new code.
 */
export function renderImageMarkdown(
  info: BnfDocInfo,
  description: ImageDescription,
  ctx: DocumentContext & { iiifUrl?: string },
): string {
  const lines: string[] = [renderHeader(info)];

  lines.push("## Type visuel");
  lines.push(description.typeVisuel);
  lines.push("");

  if (description.titreApparent) {
    lines.push("## Titre lisible sur le document");
    lines.push(description.titreApparent);
    lines.push("");
  }

  lines.push("## Sujet");
  lines.push(description.sujet);
  lines.push("");

  lines.push("## Description");
  lines.push(description.descriptionLongue);
  lines.push("");

  if (description.scenesEtElements.length > 0) {
    lines.push("## Scènes et éléments visuels");
    for (const el of description.scenesEtElements) lines.push(`- ${el}`);
    lines.push("");
  }

  if (description.legendes.length > 0) {
    lines.push("## Inscriptions et légendes");
    for (const l of description.legendes) lines.push(`- ${l}`);
    lines.push("");
  }

  if (description.echelle) {
    lines.push("## Échelle");
    lines.push(description.echelle);
    lines.push("");
  }

  if (description.motsCles.length > 0) {
    lines.push("## Mots-clés");
    lines.push(description.motsCles.join(", "));
    lines.push("");
  }

  if (ctx.iiifUrl) {
    lines.push("## Image source");
    lines.push(`<${ctx.iiifUrl}>`);
    lines.push("");
  }

  return lines.join("\n");
}
