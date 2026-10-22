import { z } from "zod"

/**
 * `message.usage` as the turn runner stores it (Anthropic token counts). Only
 * the two counters the usage reports read are named; the cache counters ride
 * along unread. A value of any other shape is a corrupt row, so parsing it
 * throws rather than counting it as zero.
 */
export const messageUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
})
export type MessageUsage = z.infer<typeof messageUsageSchema>
