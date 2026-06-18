"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import { tokenizeMarkdown } from "@/lib/citations/syntax"
import type { ParsedCitation } from "@/lib/citations/syntax"
import { CitationPill } from "./citation-pill"

interface NoteBodyProps {
  body: string
  onCitationClick: (c: ParsedCitation) => void
}

export function NoteBody({ body, onCitationClick }: NoteBodyProps) {
  const tokens = tokenizeMarkdown(body)

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
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
          >
            {token.text}
          </ReactMarkdown>
        )
      })}
    </div>
  )
}
