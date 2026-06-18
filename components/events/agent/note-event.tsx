// components/events/agent/note-event.tsx
// Reserved for slice 5 (RAG research agent + notes).
// Stub: renders a minimal "note created / updated" row with no i18n or icon
// overhead until the full implementation lands.

export function EventNoteRow({ noteId: _noteId, title, kind }: { noteId: string; title: string; kind: string }) {
  return (
    <div className="text-xs text-muted-foreground">
      {kind === "created" ? "Note créée" : "Note mise à jour"} · {title}
    </div>
  )
}
