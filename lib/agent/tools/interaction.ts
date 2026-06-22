/**
 * Interaction tools — let the agent hand a structured choice back to the user.
 *
 * `ask_user` renders an interactive multiple-choice chooser in the chat instead
 * of writing the options as prose. Calling it ENDS THE TURN: the handler returns
 * an acknowledgement instructing the model to stop, the UI renders the chooser
 * from the persisted tool input, and the user's selections are sent as the next
 * user message (a new turn). There is no mid-turn suspend/resume.
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"

export const askUserTool = defineTool<
  z.ZodObject<{
    intro: z.ZodOptional<z.ZodString>
    questions: z.ZodArray<
      z.ZodObject<{
        question: z.ZodString
        header: z.ZodOptional<z.ZodString>
        multiSelect: z.ZodOptional<z.ZodBoolean>
        options: z.ZodArray<
          z.ZodObject<{
            label: z.ZodString
            description: z.ZodOptional<z.ZodString>
          }>
        >
      }>
    >
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.askUser,
  description:
    "Ask the librarian one to four structured multiple-choice questions and let " +
    "them answer by clicking options — use this INSTEAD of writing choices as " +
    "prose (e.g. 'Option A / B / C'). Ideal for scoping decisions: chronological " +
    "range, languages, document types, depth, which subset to add, etc. " +
    "CALL THIS AS THE FINAL ACTION OF YOUR TURN, AT MOST ONCE: it ends the turn. " +
    "Never emit two ask_user calls in the same turn — put every question you have " +
    "into ONE ask_user (up to 4 questions). Do not write anything after it and do " +
    "not call other tools — the user will reply by selecting options, which " +
    "arrives as your next message. Each question needs a " +
    "short question text and 2–6 concise options; set multiSelect=true when more " +
    "than one option may be chosen. Provide an optional `intro` framing the set " +
    "(e.g. 'Cadrons le corpus avant de chercher'). Write all text in French.",
  inputSchema: z.object({
    intro: z
      .string()
      .max(200)
      .optional()
      .describe("Optional one-line framing shown above the questions (French)."),
    questions: z
      .array(
        z.object({
          question: z.string().min(1).max(200).describe("The question (French)."),
          header: z
            .string()
            .max(40)
            .optional()
            .describe("Optional very short label/chip for the question."),
          multiSelect: z
            .boolean()
            .optional()
            .describe("Allow selecting more than one option. Default false."),
          options: z
            .array(
              z.object({
                label: z.string().min(1).max(120).describe("Option text (French)."),
                description: z
                  .string()
                  .max(160)
                  .optional()
                  .describe("Optional clarifying sub-text for the option."),
              }),
            )
            .min(2)
            .max(6)
            .describe("2–6 mutually exclusive choices (unless multiSelect)."),
        }),
      )
      .min(1)
      .max(4)
      .describe("1–4 questions."),
  }),
  // No side effects: the tool input (the questions) is what the UI renders. The
  // turn ends after this returns — the result just tells the model to stop.
  handler: async (input) => {
    return {
      status: "awaiting_user_selection",
      asked: input.questions.length,
      note:
        "Questions posées à l'utilisateur via une interface à choix. Termine ton " +
        "tour maintenant : n'ajoute aucun texte et n'appelle aucun autre outil. " +
        "L'utilisateur répondra en sélectionnant des options ; ses réponses " +
        "arriveront dans le prochain message.",
    }
  },
})

export const interactionTools = [askUserTool] as const
