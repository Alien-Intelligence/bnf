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
 * Surfaces the server's message when there is one. The API answers 409 (name
 * taken) and 422 (unknown email, unusable name, refused share) with a French
 * sentence the user can act on; swallowing it into a generic "erreur" would
 * hide the one thing they need to know.
 */
export async function readError(
  res: Response,
  fallback: string,
): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === "string" && body.error.length > 0) {
      return new Error(body.error)
    }
  } catch {
    // Non-JSON body (a proxy error page, say) — fall through to the fallback.
  }
  return new Error(`${fallback}: ${res.status}`)
}
