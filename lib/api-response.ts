/**
 * Typed JSON response helpers.
 *
 * ok<T>        → raw T at top level, status 200 (or custom)
 * Error shapes → { error: string, issues?: unknown }
 *
 * These are the ONLY way to build a JSON response in a route handler.
 * Never call Response.json() or NextResponse.json() directly.
 */

export function ok<T>(data: T, init?: number | ResponseInit): Response {
  const status = typeof init === "number" ? init : 200
  const responseInit: ResponseInit =
    typeof init === "number" || init === undefined ? { status } : { status: 200, ...init }
  return Response.json(data, responseInit)
}

export function badRequest(message: string, issues?: unknown): Response {
  return Response.json({ error: message, issues }, { status: 400 })
}

export function notFound(message = "Not found"): Response {
  return Response.json({ error: message }, { status: 404 })
}

export function unauthorized(message = "Unauthorized"): Response {
  return Response.json({ error: message }, { status: 401 })
}

export function forbidden(message = "Forbidden"): Response {
  return Response.json({ error: message }, { status: 403 })
}

export function conflict(message = "Conflict"): Response {
  return Response.json({ error: message }, { status: 409 })
}

export function unprocessable(message: string, issues?: unknown): Response {
  return Response.json({ error: message, issues }, { status: 422 })
}
