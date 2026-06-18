// models/messages/schema.ts
// Domain enums and re-exported Prisma types for the Message and ToolCall models.
// No `import "server-only"` — schema is referenced by both client and server.
import type { Message, ToolCall } from "@/lib/generated/prisma/client"

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
