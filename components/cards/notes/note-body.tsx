"use client"

import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import { tokenizeMarkdown } from "@/lib/citations/syntax"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { CitationPill } from "./citation-pill"

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
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand-teal underline underline-offset-2 hover:text-brand-teal/80"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-5 border-border" />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-2.5 py-1.5 text-left font-semibold text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border px-2.5 py-1.5 align-top text-neutral-200">
      {children}
    </td>
  ),
}

export function NoteBody({ body, onCitationClick }: NoteBodyProps) {
  const tokens = tokenizeMarkdown(body)

  return (
    <div className="max-w-none text-neutral-200">
      {tokens.map((token, i) => {
        if (token.type === "citation") {
          return (
            <CitationPill
              key={i}
              citation={token.citation}
              onClick={onCitationClick}
            />
          )
        }
        return (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={MD_COMPONENTS}
          >
            {token.text}
          </ReactMarkdown>
        )
      })}
    </div>
  )
}
