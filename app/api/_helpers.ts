/**
 * Shared request parsing helpers for route handlers.
 *
 * parseBody  — validates the JSON request body against a Zod schema.
 * parseQuery — validates URL search params against a Zod schema.
 *
 * Both return either the validated data or a Response (400). Callers must
 * check with `if (parsed instanceof Response) return parsed` before use.
 *
 * This file is colocated in app/api/ as a private utility (underscore prefix).
 * Next.js only routes files named route.ts/page.tsx — this file is never
 * exposed as an HTTP endpoint.
 */
import { z } from "zod"
import { badRequest } from "@/lib/api-response"

export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<T | Response> {
  let json: unknown
  try {
    json = await req.json()
  } catch {
    return badRequest("Invalid JSON body")
  }
  const result = schema.safeParse(json)
  if (!result.success) return badRequest("Invalid request body", result.error.issues)
  return result.data
}

export function parseQuery<T>(
  req: Request,
  schema: z.ZodType<T>,
): T | Response {
  const url = new URL(req.url)
  const obj: Record<string, string> = {}
  url.searchParams.forEach((v, k) => {
    obj[k] = v
  })
  const result = schema.safeParse(obj)
  if (!result.success) return badRequest("Invalid query params", result.error.issues)
  return result.data
}
