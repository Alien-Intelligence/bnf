"use client"

import { useMemo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import {
  parseCitations,
  parseImageCitations,
  CITATION_REGEX,
  IMAGE_CITATION_REGEX,
} from "@/lib/citations/syntax"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { iiifImageUrl } from "@/lib/citations/external"
import { NOTE_IMAGE_IIIF_SIZE } from "@/lib/constants"
import { CitationPill } from "./citation-pill"

// Fragment tags that carry a citation / image embed through markdown rendering.
// Both are protocol-less (no colon), so react-markdown's urlTransform and
// rehype-sanitize pass them through untouched; the `a` / `img` components below
// swap them for the real pill / figure (with the IIIF URL set client-side,
// after sanitize).
const CITE_HREF_PREFIX = "#cite-"
const IMAGE_SRC_PREFIX = "#img-"

interface NoteBodyProps {
  body: string
  onCitationClick: (c: ParsedCitation) => void
}

// Markdown element styles ported 1:1 from the prototype's `mdToHtml`
// (design/BnF Corpus Research.dc.html lines 1582-1604): `###` is a mono
// uppercase eyebrow, `##` a weighted heading, list items carry a teal em-dash,
// and blockquotes get the teal left rule. GFM (tables, etc.) still flows through
// react-markdown, so agent notes richer than the prototype keep rendering.
const MD_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2.5 mt-7 text-[21px] font-semibold tracking-tight text-foreground first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2.5 mt-6 text-[17px] font-semibold tracking-tight text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-6 font-mono text-xs uppercase tracking-wide text-muted-foreground first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-4 text-sm font-semibold text-foreground">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="mb-3 text-sm leading-[1.7] text-neutral-200">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-2 flex list-none flex-col gap-1.75 pl-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1.75 pl-5 marker:text-neutral-600">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="flex gap-2.5 text-sm leading-[1.7] text-neutral-200 before:shrink-0 before:text-brand-teal before:content-['—']">
      <span className="min-w-0">{children}</span>
    </li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3.5 border-l-2 border-brand-teal pl-3.5 text-[13.5px] italic leading-[1.6] text-muted-foreground">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-neutral-200">{children}</em>,
  code: ({ children }) => (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-brand-teal">
      {children}
    </code>
  ),
  // `a` and `img` are supplied per-instance in NoteBody: `a` maps `#cite-<n>`
  // hrefs to <CitationPill> (else a normal external link), `img` maps `#img-<n>`
  // srcs to a folio <figure>.
  hr: () => <hr className="my-5 border-border" />,
  table: ({ children }) => (
    <div className="my-5 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-3 py-2 text-left align-bottom font-mono text-[10.5px] font-medium uppercase tracking-wide whitespace-nowrap text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-3 py-2.5 align-top leading-relaxed text-neutral-200">
      {children}
    </td>
  ),
}

export function NoteBody({ body, onCitationClick }: NoteBodyProps) {
  // Image embeds and text citations in left-to-right order. The rewrite below
  // numbers its `#img-<n>` / `#cite-<n>` carriers in the same order, so index n
  // maps straight back to the matching ParsedCitation. CITATION_REGEX excludes
  // `![[…]]` (negative lookbehind), so the two arrays don't overlap.
  const images = useMemo(() => parseImageCitations(body), [body])
  const citations = useMemo(() => parseCitations(body), [body])

  // Rewrite citation/image tokens into inline markdown on the RAW body, BEFORE
  // parsing. Images become `![n](#img-n)`, citations `[n](#cite-n)` — both stay
  // in their phrasing context (inline within the paragraph/list/quote) instead
  // of breaking the block flow. It must run pre-parse: once markdown is parsed,
  // `[[…]]` is ambiguous (a shortcut link reference) and no longer survives as
  // plain text a post-parse plugin could match.
  const markdown = useMemo(() => {
    let img = 0
    let cite = 0
    return body
      .replace(IMAGE_CITATION_REGEX, () => `![${img}](${IMAGE_SRC_PREFIX}${img++})`)
      .replace(CITATION_REGEX, () => `[${cite}](${CITE_HREF_PREFIX}${cite++})`)
  }, [body])

  const components: Components = useMemo(
    () => ({
      ...MD_COMPONENTS,
      a: ({ href, children }) => {
        if (href?.startsWith(CITE_HREF_PREFIX)) {
          const citation = citations[Number(href.slice(CITE_HREF_PREFIX.length))]
          if (citation) {
            return <CitationPill citation={citation} onClick={onCitationClick} />
          }
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-teal underline underline-offset-2 hover:text-brand-teal/80"
          >
            {children}
          </a>
        )
      },
      img: ({ src }) => {
        if (typeof src === "string" && src.startsWith(IMAGE_SRC_PREFIX)) {
          const image = images[Number(src.slice(IMAGE_SRC_PREFIX.length))]
          if (image) {
            return (
              // <button> is phrasing content, so it's valid inside the <p> that
              // wraps a lone image — a <figure> would not be. Clicking opens the
              // same source panel as a citation pill.
              <button
                type="button"
                onClick={() => onCitationClick(image)}
                className="my-4 block w-full overflow-hidden rounded-lg border bg-muted/20 text-left transition-colors hover:border-brand-teal/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={iiifImageUrl(image.ark, image.folio, NOTE_IMAGE_IIIF_SIZE)}
                  alt={image.label}
                  className="block w-full object-contain"
                  loading="lazy"
                />
                <span className="block border-t px-3 py-2 font-mono text-[11px] leading-snug text-muted-foreground">
                  {image.label} · f{image.folio}
                </span>
              </button>
            )
          }
        }
        return null
      },
    }),
    [citations, images, onCitationClick],
  )

  return (
    <div className="max-w-none text-neutral-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
