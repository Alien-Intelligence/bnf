// lib/filters.ts
// Filter schemas shared by the buffer and the corpus (agent tools and REST).
// Pure — zod and constants only.
import { z } from "zod"
import { TEXT_FILTER_MAX_VALUES, TEXT_FILTER_MIN_CHARS } from "@/lib/constants"

/** Text criteria: contains-ANY, case-insensitive, accent-sensitive. */
export const textAnySchema = z
  .array(z.string().trim().min(TEXT_FILTER_MIN_CHARS))
  .min(1)
  .max(TEXT_FILTER_MAX_VALUES)
