/**
 * Client-side fetch wrapper.
 *
 * All HTTP calls from hooks go through apiFetch — never raw fetch().
 * Prepends NEXT_PUBLIC_BASE_PATH so the app works under a sub-path.
 * Sets credentials: "include" and a default Content-Type: application/json.
 *
 * readError lives here too: it is the counterpart every hook needs once
 * apiFetch has answered, so the two belong in the same place.
 */

/**
 * An app path with NEXT_PUBLIC_BASE_PATH prepended — for the rare call that
 * is a navigation rather than a fetch (a file download). Absolute URLs pass
 * through. An unset base path is the app served at the root, not a default.
 */
export function apiUrl(input: string): string {
  const basePath = process.env["NEXT_PUBLIC_BASE_PATH"] ?? ""
  return input.startsWith("/") ? `${basePath}${input}` : input
}

export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(apiUrl(input), {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
}

/**
 * A non-2xx answer from the app's API: the HTTP status, plus the server's own
 * message when it sent one. Components that must show the user something in
 * their locale map `status` to a translation key instead of rendering
 * `message`, which is the server's (French) sentence or a developer fallback.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/**
 * Surfaces the server's message when there is one. The API answers 409 (name
 * taken) and 422 (unknown email, unusable name, refused share) with a French
 * sentence the user can act on; swallowing it into a generic "erreur" would
 * hide the one thing they need to know. Always an ApiError, so callers that
 * need the status can read it.
 */
export async function readError(
  res: Response,
  fallback: string,
): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === "string" && body.error.length > 0) {
      return new ApiError(body.error, res.status)
    }
  } catch {
    // Non-JSON body (a proxy error page, say) — fall through to the fallback.
  }
  return new ApiError(`${fallback}: ${res.status}`, res.status)
}

/**
 * The server refused the request itself (a 4xx) — a filter value the data
 * does not hold, a malformed parameter. Retrying the SAME request can never
 * succeed, so the UI shows the message instead of a Retry.
 */
export class RequestRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "RequestRefusedError"
  }
}

/** TanStack Query's default retry count for reads, kept for non-refusals. */
const QUERY_DEFAULT_RETRIES = 3

/** readError for a read: a 4xx becomes a RequestRefusedError carrying the
 *  server's message; anything else stays a plain Error. */
export async function readQueryError(res: Response, fallback: string): Promise<Error> {
  const err = await readError(res, fallback)
  return res.status >= 400 && res.status < 500 ? new RequestRefusedError(err.message, res.status) : err
}

/** Retry policy for reads: a refusal is never retried; other failures are, as by default. */
export function retryUnlessRefused(failureCount: number, error: Error): boolean {
  return !(error instanceof RequestRefusedError) && failureCount < QUERY_DEFAULT_RETRIES
}
