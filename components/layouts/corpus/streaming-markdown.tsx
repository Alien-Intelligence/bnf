"use client"

// components/layouts/corpus/streaming-markdown.tsx
// Renders an agent message body as markdown, revealed word-by-word at a steady
// cadence so chunky model deltas read as a smooth "typewriter" stream rather
// than appearing in big jumps. This mirrors the @alien/chat-sdk client-side
// smoother (25ms / word) — the SDK does the same buffering on its event stream;
// we do it on the already-accumulated content because our transport
// (useTurnStream) appends raw deltas to message.content.
//
// Markdown is rendered with explicit, compact component overrides (the chat
// bubble is dense at 13px) — the app does not load @tailwindcss/typography, so
// `prose` classes would be no-ops here.

import { useEffect, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import { CHAT_STREAM_REVEAL_MS } from "@/lib/constants"

interface StreamingMarkdownProps {
  /** The full content accumulated so far (grows as deltas arrive). */
  content: string
  /** True while the turn is still streaming this message. */
  streaming: boolean
}

/** Length of the next word to reveal from `rest` — a leading run of whitespace
 *  plus one non-space token (matches the chat-sdk smoother's word chunking). */
function nextChunkLength(rest: string): number {
  const m = /^\s*\S+\s?/.exec(rest)
  return m ? m[0].length : Math.min(8, rest.length)
}

export function StreamingMarkdown({ content, streaming }: StreamingMarkdownProps) {
  // Completed/historical messages render in full immediately; only a live
  // streaming message animates its reveal.
  const [revealedLen, setRevealedLen] = useState(streaming ? 0 : content.length)

  // The latest target, read by the interval without re-subscribing on each
  // delta. Updated in an effect (never during render) so the reveal ticker can
  // always see the freshest accumulated content.
  const targetRef = useRef(content)
  useEffect(() => {
    targetRef.current = content
  }, [content])

  useEffect(() => {
    if (!streaming) {
      // Snap to the final content when the turn ends (or for history).
      setRevealedLen(targetRef.current.length)
      return
    }
    const timer = setInterval(() => {
      setRevealedLen((shown) => {
        const target = targetRef.current.length
        if (shown >= target) return shown
        const rest = targetRef.current.slice(shown)
        return shown + nextChunkLength(rest)
      })
    }, CHAT_STREAM_REVEAL_MS)
    return () => clearInterval(timer)
  }, [streaming])

  const shown = streaming ? content.slice(0, revealedLen) : content

  return (
    <div className="text-[13px] leading-[1.55] text-neutral-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={MARKDOWN_COMPONENTS}
      >
        {shown}
      </ReactMarkdown>
      {streaming && (
        <span className="ml-0.5 inline-block animate-pulse align-text-bottom">▌</span>
      )}
    </div>
  )
}

// Compact, dark-appropriate element styling for the chat bubble. Margins are
// collapsed on the first/last child so the bubble stays tight.
const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="my-2 first:mt-0 last:mb-0 whitespace-pre-wrap">{children}</p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-brand-teal underline underline-offset-2 hover:text-brand-teal/80"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-2 ml-4 list-disc space-y-1 first:mt-0 last:mb-0 marker:text-muted-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-4 list-decimal space-y-1 first:mt-0 last:mb-0 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  h1: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-[15px] font-semibold first:mt-0">{children}</h2>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-3 text-[14px] font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2.5 text-[13px] font-semibold first:mt-0">{children}</h3>
  ),
  hr: () => <hr className="my-3 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11.5px]">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-secondary p-3 font-mono text-[11.5px] leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2.5 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-2 py-1.5 text-left align-bottom font-mono text-[10px] font-medium uppercase tracking-wide whitespace-nowrap text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-2 py-1.5 align-top text-neutral-200">
      {children}
    </td>
  ),
}
