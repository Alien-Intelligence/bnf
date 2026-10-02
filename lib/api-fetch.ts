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

export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const basePath = process.env["NEXT_PUBLIC_BASE_PATH"] ?? ""
  const url = input.startsWith("/") ? `${basePath}${input}` : input
  return fetch(url, {
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
