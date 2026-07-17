/**
 * Note tool definitions for the BnF research agent.
 *
 * Five tools covering the research note lifecycle:
 *   - note_list   — list all notes for the project (most-recent first)
 *   - note_get    — fetch a single note by id (with citations)
 *   - note_create — create a new Markdown research note
 *   - note_update — replace an existing note's title/body (snapshots prior body)
 *   - note_append — append Markdown to a note without resending the whole body
 *                   (cheaper than note_update for adding findings)
 *
 * note_create / note_update / note_append publish a `note_event` via `ctx.emit`
 * so connected SSE clients receive real-time feedback without polling.
 *
 * Citation syntax: [[<ark>|<short label>|<folio>]] — the folio is mandatory
 * for deep-linking into the BnF IIIF viewer. The agent must not fabricate one.
 *
 * Note-link syntax: [[note:<note_id>|<label>]] — an INTERNAL cross-reference to
 * another note in this project. Renders as a clickable pill that opens the
 * target note. The <note_id> is a real note UUID from note_list / note_get; the
 * agent must not invent one. Use it to weave a complex project's notes together
 * (e.g. a master/index note linking its per-topic notes).
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { NoteService } from "@/models/notes/service"
import { NoteQueries } from "@/models/notes/queries"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

// ---------------------------------------------------------------------------
// note_list
// ---------------------------------------------------------------------------

export const noteListTool = defineTool<z.ZodObject<Record<never, never>>, TurnScopedCtx>({
  name: AGENT_TOOLS.noteList,
  description:
    "List all research notes for this project, ordered most-recently-updated first. " +
    "Call this before note_create to check whether a closely related note already exists — " +
    "prefer note_update over creating a near-duplicate. " +
    "Each note's id is the value to use when linking to it with [[note:<id>|<label>]].",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const notes = await NoteQueries.listForProject(ctx.projectId)
    return { notes }
  },
})

// ---------------------------------------------------------------------------
// note_get
// ---------------------------------------------------------------------------

export const noteGetTool = defineTool<
  z.ZodObject<{ id: z.ZodString }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.noteGet,
  description:
    "Fetch the full body and citations of a single note by its id. " +
    "Use this to read a note before deciding whether to update it.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The note's UUID."),
  }),
  handler: async (input, _ctx) => {
    const note = await NoteQueries.get(input.id)
    if (!note) return { error: "note_not_found" }
    return { note }
  },
})

// ---------------------------------------------------------------------------
// note_create
// ---------------------------------------------------------------------------

export const noteCreateTool = defineTool<
  z.ZodObject<{
    title: z.ZodString
    body_md: z.ZodString
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.noteCreate,
  description:
    "Create a new Markdown research note. " +
    "Structure the body with ## / ### sections, bullet lists, and inline citations. " +
    "Citation syntax: [[<ark>|<short label>|<folio>]] — folio is mandatory; " +
    "if you do not have a folio from rag_query, cite in prose only. " +
    "Embed a folio image with ![[<ark>|<caption>|<folio>]] (the same syntax with a leading !) " +
    "to show a page — the image is fetched from Gallica by ark+folio, no link needed. " +
    "Link to another note with [[note:<note_id>|<label>]] (ids from note_list/note_get) — " +
    "the pill opens that note. " +
    "Call note_list first to avoid near-duplicates.",
  inputSchema: z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("A clear, specific note title (max 200 chars)."),
    body_md: z
      .string()
      .min(1)
      .max(200_000)
      .describe(
        "The note body in Markdown. Use [[ark|label|folio]] for inline citations, " +
          "![[ark|caption|folio]] to embed a folio image, and [[note:<id>|<label>]] to link " +
          "another note.",
      ),
  }),
  handler: async (input, ctx) => {
    const note = await NoteService.create({
      projectId: ctx.projectId,
      appSessionId: ctx.appSessionId,
      title: input.title,
      bodyMd: input.body_md,
    })

    ctx.emit?.({
      type: "note_event",
      data: { kind: "created", noteId: note.id, title: note.title },
    })

    return { note_id: note.id, title: note.title, citation_count: note.citationCount }
  },
})

// ---------------------------------------------------------------------------
// note_update
// ---------------------------------------------------------------------------

export const noteUpdateTool = defineTool<
  z.ZodObject<{
    id: z.ZodString
    title: z.ZodOptional<z.ZodString>
    body_md: z.ZodOptional<z.ZodString>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.noteUpdate,
  description:
    "Update an existing note's title and/or body. " +
    "The previous body is automatically snapshotted to NoteVersion before mutation. " +
    "Omit a field to leave it unchanged. " +
    "Use this to extend a note with new findings rather than creating a near-duplicate. " +
    "Body supports [[ark|label|folio]] citations, ![[ark|caption|folio]] image embeds, and " +
    "[[note:<id>|<label>]] links to other notes.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The note's UUID."),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("New title, if changing it."),
    body_md: z
      .string()
      .max(200_000)
      .optional()
      .describe(
        "New body in Markdown, if replacing it. Use [[ark|label|folio]] citations and " +
          "![[ark|caption|folio]] image embeds.",
      ),
  }),
  handler: async (input, ctx) => {
    const note = await NoteService.update(input.id, {
      title: input.title,
      bodyMd: input.body_md,
    })

    ctx.emit?.({
      type: "note_event",
      data: { kind: "updated", noteId: note.id, title: note.title },
    })

    return { note_id: note.id, title: note.title, citation_count: note.citationCount }
  },
})

// ---------------------------------------------------------------------------
// note_append
// ---------------------------------------------------------------------------

export const noteAppendTool = defineTool<
  z.ZodObject<{
    id: z.ZodString
    body_md: z.ZodString
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.noteAppend,
  description:
    "Append Markdown to the END of an existing note WITHOUT resending the whole body. " +
    "PREFER THIS over note_update to add new findings to a note: you emit only the new " +
    "passage, so it is much faster and far cheaper than rewriting the entire note. " +
    "The new text is placed after a blank line; the prior body is snapshotted to " +
    "NoteVersion and citations are re-parsed over the whole note. " +
    "Use [[<ark>|<short label>|<folio>]] citations, ![[<ark>|<caption>|<folio>]] image embeds, " +
    "and [[note:<id>|<label>]] links to other notes. " +
    "Use note_update only for surgical edits to existing text (fixing or removing).",
  inputSchema: z.object({
    id: z.string().uuid().describe("The note's UUID."),
    body_md: z
      .string()
      .trim()
      .min(1)
      .max(200_000)
      .describe(
        "Markdown to append at the end of the note. Include your own ## / ### headings; " +
          "it is added after a blank line. Use [[ark|label|folio]] citations, " +
          "![[ark|caption|folio]] image embeds, and [[note:<id>|<label>]] note links.",
      ),
  }),
  handler: async (input, ctx) => {
    const note = await NoteService.append(input.id, { bodyMd: input.body_md })

    ctx.emit?.({
      type: "note_event",
      data: { kind: "updated", noteId: note.id, title: note.title },
    })

    return { note_id: note.id, title: note.title, citation_count: note.citationCount }
  },
})

// Convenience array for the registry builder.
export const noteTools = [
  noteListTool,
  noteGetTool,
  noteCreateTool,
  noteUpdateTool,
  noteAppendTool,
] as const
