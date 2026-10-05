// lib/validation/json.ts
// A JSON value, validated, typed as what Prisma accepts for a Json column.
// Loose records (`z.record(z.string(), z.unknown())`) parse a wire payload
// without fixing its shape; writing one to a Json column needs proof that it
// IS JSON — this schema is that proof, instead of an `as never` cast.
import { z } from "zod"

import type { Prisma } from "@/lib/generated/prisma/client"

/** Any JSON value except a top-level null (a Json column's null is DbNull/JsonNull). */
export const inputJsonValueSchema: z.ZodType<Prisma.InputJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([inputJsonValueSchema, z.null()])),
    z.record(z.string(), z.union([inputJsonValueSchema, z.null()])),
  ]),
)

/**
 * `value` as a Json-column input. Throws a ZodError naming the offending path
 * when it is not JSON (undefined, a function, a bigint…) — never written as
 * whatever the cast would have let through.
 */
export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return inputJsonValueSchema.parse(value)
}
