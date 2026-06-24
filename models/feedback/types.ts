import { z } from "zod"

// One schema shared by the route (parseBody), the hook input, and the form
// resolver. The literals mirror FEEDBACK_TARGET / FEEDBACK_RATING in schema.ts;
// per playbook/models.md, types.ts takes no internal imports, so they are
// repeated here intentionally (the two are kept in lockstep by review).
export const submitFeedbackSchema = z.object({
  target: z.enum(["session", "note", "turn"]),
  targetId: z.string().uuid(),
  rating: z.enum(["bad", "ok", "great"]),
  comment: z.string().trim().max(2_000).optional(),
})
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>
