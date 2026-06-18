/**
 * Client-side fetch wrapper.
 *
 * All HTTP calls from hooks go through apiFetch — never raw fetch().
 * Prepends NEXT_PUBLIC_BASE_PATH so the app works under a sub-path.
 * Sets credentials: "include" and a default Content-Type: application/json.
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
