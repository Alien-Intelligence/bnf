// models/messages/schema.ts
// Domain enums and re-exported Prisma types for the Message and ToolCall models.
// No `import "server-only"` — schema is referenced by both client and server.
import type { Message, Prisma, ToolCall } from "@/lib/generated/prisma/client"

export const MESSAGE_ROLE = {
  USER: "user",
  ASSISTANT: "assistant",
  EVENT: "event",
} as const
export type MessageRole = (typeof MESSAGE_ROLE)[keyof typeof MESSAGE_ROLE]

export const MESSAGE_STATUS = {
  DRAFT: "draft",
  STREAMING: "streaming",
  DONE: "done",
  ERROR: "error",
  CANCELED: "canceled",
} as const
export type MessageStatus = (typeof MESSAGE_STATUS)[keyof typeof MESSAGE_STATUS]

export const TOOL_CALL_STATUS = {
  RUNNING: "running",
  OK: "ok",
  ERROR: "error",
} as const
export type ToolCallStatus = (typeof TOOL_CALL_STATUS)[keyof typeof TOOL_CALL_STATUS]

export type { Message, ToolCall }

// Query shape: a project with its owner's email and the usage column of every
// message of every session — what the admin usage export aggregates.
export const projectWithMessageUsage = {
  select: {
    id: true,
    name: true,
    ownerId: true,
    owner: { select: { email: true } },
    appSessions: {
      select: {
        messages: { select: { usage: true, createdAt: true } },
      },
    },
  },
} satisfies Prisma.ProjectDefaultArgs
export type ProjectWithMessageUsage = Prisma.ProjectGetPayload<typeof projectWithMessageUsage>

/** One project's token totals: all-time and inside the trailing window. */
export type ProjectUsageTotals = {
  projectId: string
  projectName: string
  ownerId: string
  ownerEmail: string
  tokensIn: number
  tokensOut: number
  messageCount: number
  windowTokensIn: number
  windowTokensOut: number
}
