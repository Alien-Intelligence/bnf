// models/notes/schema.ts
// Re-exported Prisma types for the Note, NoteVersion, and Citation models.
// No domain enums for notes in this slice.
// No `import "server-only"` — schema is referenced by both client and server.
import type { Note, NoteVersion, Citation } from "@/lib/generated/prisma/client"

export type { Note, NoteVersion, Citation }
