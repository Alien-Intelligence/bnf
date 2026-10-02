// scripts/e2e-auth.ts
// The auth round trip over REAL HTTP, against a running dev server:
//
//   npm run dev -- -p <port>      # port = APP_URL's, in another terminal
//   npm run e2e:auth
//
// Sign up a throwaway account, then prove that `/`, `/sign-in` and `/sign-up`
// follow the session in both locales and that a hostile `?next=` never leaves
// the app. Later phases extend this file with the sign-out round trip and the
// workspace shell. Every GET uses `redirect: "manual"` and asserts on the
// status and the Location header: that is the contract a browser sees.
//
// Base URL: `E2E_BASE_URL` when set, else the app's own `APP_URL` (loaded from
// .env.local by the npm script). No silent default — a wrong port would make
// every assertion read as a regression.
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { routing } from "@/i18n/routing"
import { prisma } from "@/lib/db"
import { AUTH_QUERY, LOGIN_METHOD, ROUTES, SIGNED_OUT_NOTICE } from "@/lib/constants"
import { SSO_LOGOUT } from "@/models/users/schema"
import fr from "@/messages/fr.json"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { check, printVerdict, requireServer, section } from "./e2e/harness"

const BASE = resolveBase()
const PW = "TestPassword123!"

/** Per-request ceiling. Generous: the dev server compiles a page on first hit. */
const REQUEST_TIMEOUT_MS = 60_000
/** Wall-clock ceiling on the whole run (CLAUDE_ERROR_PATTERNS §14). */
const RUN_DEADLINE_MS = 300_000
const RUN_DEADLINE = AbortSignal.timeout(RUN_DEADLINE_MS)

/** Every request is bounded by its own timeout and by the run's deadline. */
function bounded(): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), RUN_DEADLINE])
}

/** The endpoints this script drives. */
const ENDPOINT = {
  signUp: "/api/auth/sign-up/email",
  signIn: "/api/auth/sign-in/email",
  signOut: "/api/sign-out",
  projects: "/api/projects",
} as const

/** better-auth's session cookie name (no `__Secure-` prefix over plain http). */
const SESSION_COOKIE = "better-auth.session_token"

/** What Next answers to redirect() from a server component: 307 Temporary Redirect. */
const REDIRECT_STATUS = 307

const DEFAULT_LOCALE = routing.defaultLocale
const OTHER_LOCALE = otherLocale()

function otherLocale(): (typeof routing.locales)[number] {
  const other = routing.locales.find((l) => l !== routing.defaultLocale)
  if (!other) throw new Error("routing.locales has no second locale to test prefixes with")
  return other
}

function resolveBase(): string {
  const raw = process.env["E2E_BASE_URL"] ?? process.env["APP_URL"]
  if (!raw) {
    throw new Error("Set E2E_BASE_URL or APP_URL (the dev server to test against)")
  }
  return raw.replace(/\/+$/, "")
}

type Account = { cookie: string; id: string; email: string }

/** Sign-up over HTTP, exactly as the form does it (origin header included:
 *  better-auth refuses a cross-origin POST). */
async function signUp(): Promise<Account> {
  const email = `e2e-auth-${randomUUID().slice(0, 8)}@bnf-e2e.local`
  const res = await fetch(`${BASE}${ENDPOINT.signUp}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PW, name: `e2e auth ${email}` }),
    signal: bounded(),
  })
  if (!res.ok) throw new Error(`sign-up: ${res.status} ${await res.text()}`)
  const cookie = cookieHeader(res)
  check("1. sign-up answers 200 with a session cookie", cookie.length > 0, `status=${res.status} cookie=${cookie.slice(0, 40)}…`)
  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  return { cookie, id: user.id, email }
}

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")
}

/** A page GET as the browser would issue it, without following redirects. */
async function page(path: string, cookie: string | null): Promise<{ status: number; location: string | null; text: () => Promise<string> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    redirect: "manual",
    headers: cookie ? { cookie } : {},
    signal: bounded(),
  })
  const location = res.headers.get("location")
  return {
    status: res.status,
    // Location may be absolute or relative; compare on path + query.
    location: location === null ? null : pathAndQuery(location),
    text: () => res.text(),
  }
}

function pathAndQuery(location: string): string {
  const url = new URL(location, BASE)
  return `${url.pathname}${url.search}`
}

function expectRedirect(name: string, got: { status: number; location: string | null }, expected: string): void {
  const ok = got.status === REDIRECT_STATUS && got.location === expected
  check(name, ok, `expected ${REDIRECT_STATUS} → ${expected}, got ${got.status} → ${got.location ?? "(no location)"}`)
}

/** The sign-out response as the client reads it (SignOutResult). */
const signOutBodySchema = z.object({ redirectTo: z.string(), ssoLogout: z.string() })

/** The one field of POST /api/projects' answer the shell check needs. */
const projectIdSchema = z.object({ id: z.string() })

/** A JSON API call as the browser issues it (same-origin, cookie attached). */
async function api(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", origin: BASE, cookie, ...init.headers },
    signal: bounded(),
  })
}

/** An email sign-in; fails the run at once if refused, so no later check
 *  misreports a missing cookie as its own failure. */
async function signInEmail(account: Account): Promise<{ cookie: string; status: number }> {
  const res = await fetch(`${BASE}${ENDPOINT.signIn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: BASE },
    body: JSON.stringify({ email: account.email, password: PW }),
    signal: bounded(),
  })
  if (!res.ok) throw new Error(`sign-in: ${res.status} ${await res.text()}`)
  return { cookie: cookieHeader(res), status: res.status }
}

/**
 * Run `body`, then `teardown`, whatever happened. A teardown failure never
 * hides the run's own error: both are thrown together.
 */
async function withTeardown(label: string, body: () => Promise<void>, teardown: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (primary) {
    try {
      await teardown()
    } catch (cleanup) {
      throw new AggregateError([primary, cleanup], `${label}: the run and its teardown both failed`)
    }
    throw primary
  }
  await teardown()
}

function sessionToken(cookie: string): string {
  const prefix = `${SESSION_COOKIE}=`
  const pair = cookie.split("; ").find((c) => c.startsWith(prefix))
  if (!pair) throw new Error(`no ${SESSION_COOKIE} in the cookie`)
  // The cookie value is `<token>.<signature>`, URL-encoded; the DB stores the token.
  return decodeURIComponent(pair.slice(prefix.length)).split(".")[0]
}

async function signOutRoundTrip(account: Account): Promise<void> {
  // 10. A fresh email sign-in, so the session row carries the login method.
  const { cookie, status } = await signInEmail(account)
  check("10. POST /api/auth/sign-in/email → a fresh session cookie", cookie.length > 0, `status=${status}`)
  const token = sessionToken(cookie)

  // 11. The hook stamped the method.
  const row = await prisma.session.findUnique({ where: { token }, select: { loginMethod: true } })
  check("11. the session row records loginMethod=email", row?.loginMethod === LOGIN_METHOD.EMAIL, `loginMethod=${String(row?.loginMethod)}`)

  // 12. The cookie works.
  const before = await api(ENDPOINT.projects, cookie)
  check("12. GET /api/projects with the cookie → 200", before.status === 200, `status=${before.status}`)

  // 13. Our sign-out route.
  const out = await api(ENDPOINT.signOut, cookie, { method: "POST", body: JSON.stringify({ locale: DEFAULT_LOCALE }) })
  // Parse only a 200: on main the route does not exist and answers an HTML 404.
  const outBody = out.ok ? signOutBodySchema.safeParse(await out.json()) : null
  const expectedRedirect = `${ROUTES.signIn}?${AUTH_QUERY.SIGNED_OUT}=${SIGNED_OUT_NOTICE.DONE}`
  check(
    "13. POST /api/sign-out {locale: fr} → 200 { redirectTo: /sign-in?signedOut=done, ssoLogout: not_applicable }",
    outBody?.success === true &&
      outBody.data.redirectTo === expectedRedirect &&
      outBody.data.ssoLogout === SSO_LOGOUT.NOT_APPLICABLE,
    `status=${out.status} body=${JSON.stringify(outBody?.success ? outBody.data : outBody?.error.issues ?? null)}`,
  )
  const clearing = out.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`) && /Max-Age=0|Expires=/i.test(c))
  check("13b. the response expires the session cookie", clearing.length === 1, out.headers.getSetCookie().join(" | ").slice(0, 200))

  // 14. The row is gone.
  const count = await prisma.session.count({ where: { token } })
  check("14. the session row is deleted", count === 0, `count=${count}`)

  // 15–17. The old cookie is dead everywhere.
  const after = await api(ENDPOINT.projects, cookie)
  check("15. GET /api/projects with the OLD cookie → 401", after.status === 401, `status=${after.status}`)
  expectRedirect("16. GET / with the old cookie → /sign-in", await page("/", cookie), ROUTES.signIn)
  const again = await api(ENDPOINT.signOut, cookie, { method: "POST", body: JSON.stringify({ locale: DEFAULT_LOCALE }) })
  check("17. POST /api/sign-out with the old cookie → 401 (idempotent)", again.status === 401, `status=${again.status}`)

  // 18. parseBody refuses a bad locale, with a valid cookie.
  const fresh = await signInEmail(account)
  const bad = await api(ENDPOINT.signOut, fresh.cookie, { method: "POST", body: JSON.stringify({ locale: "xx" }) })
  check("18. POST /api/sign-out {locale: xx} → 400", bad.status === 400, `status=${bad.status}`)
}

/** The share button's text as the default (French) locale renders it. */
const SHARE_LABEL = `>${fr.nav.share}<`

/** The rendered `<header>…</header>` of a page, or null when it has none. */
function headerHtml(html: string): string | null {
  const start = html.indexOf("<header")
  if (start === -1) return null
  const end = html.indexOf("</header>", start)
  return end === -1 ? null : html.slice(start, end)
}

async function workspaceShell(account: Account): Promise<void> {
  const created = await api(ENDPOINT.projects, account.cookie, {
    method: "POST",
    body: JSON.stringify({ name: `e2e auth shell ${randomUUID().slice(0, 8)}` }),
  })
  if (created.status !== 201) throw new Error(`POST /api/projects: ${created.status} ${await created.text()}`)
  const { id } = projectIdSchema.parse(await created.json())
  await withTeardown("workspace shell", async () => {
    // 19. The project shell: the layout renders the header once, for every step.
    const res = await page(ROUTES.rechercher(id), account.cookie)
    const header = headerHtml(await res.text())
    check(
      "19. GET /projects/<id>/rechercher → 200 with a link to /projects in the <header>",
      res.status === 200 && header !== null && header.includes(`href="${ROUTES.projects}"`),
      `status=${res.status} header=${header === null ? "none" : "present"}`,
    )
    // 19b. The owner of an own-corpus project may share it, from inside it (#1).
    check(
      "19b. …and the owner sees « Partager » in that header",
      header !== null && header.includes(SHARE_LABEL),
      header === null ? "no header" : "no share button",
    )
    // 19c. A project that does not exist: the page 404s and the layout adds no
    // header, so a 404 never carries a project's name or its share button.
    const missing = await page(ROUTES.rechercher(randomUUID()), account.cookie)
    const missingHtml = await missing.text()
    check(
      "19c. GET /projects/<unknown id>/rechercher → 404 without the project header",
      missing.status === 404 && !missingHtml.includes(SHARE_LABEL),
      `status=${missing.status}`,
    )
  }, () => cleanupProject(id))
}

async function main(): Promise<void> {
  await requireServer(BASE)

  section("Phase 1 — `/`, `/sign-in`, `/sign-up` follow the session (#4)")
  const account = await signUp()
  const { cookie } = account
  const someProjectStep = ROUTES.rechercher("x")

  await withTeardown(
    "auth round trip",
    async () => {
      expectRedirect("2. GET / signed in → /projects", await page("/", cookie), ROUTES.projects)
      expectRedirect(
        `3. GET /${OTHER_LOCALE} signed in → /${OTHER_LOCALE}/projects`,
        await page(`/${OTHER_LOCALE}`, cookie),
        `/${OTHER_LOCALE}${ROUTES.projects}`,
      )
      expectRedirect("4. GET /sign-in signed in → /projects", await page(ROUTES.signIn, cookie), ROUTES.projects)
      expectRedirect(
        "5. GET /sign-in?next=<in-app path> signed in → that path",
        await page(`${ROUTES.signIn}?${AUTH_QUERY.NEXT}=${encodeURIComponent(someProjectStep)}`, cookie),
        someProjectStep,
      )
      for (const hostile of ["//evil.example", "https://evil.example"]) {
        expectRedirect(
          `6. GET /sign-in?next=${hostile} signed in → /projects, never off-site`,
          await page(`${ROUTES.signIn}?${AUTH_QUERY.NEXT}=${encodeURIComponent(hostile)}`, cookie),
          ROUTES.projects,
        )
      }
      expectRedirect("6b. GET /sign-up signed in → /projects", await page(ROUTES.signUp, cookie), ROUTES.projects)
      expectRedirect("7. GET / signed out → /sign-in", await page("/", null), ROUTES.signIn)
      expectRedirect(
        `8. GET /${OTHER_LOCALE}/projects signed out → /${OTHER_LOCALE}/sign-in?next=/projects (with next)`,
        await page(`/${OTHER_LOCALE}${ROUTES.projects}`, null),
        `/${OTHER_LOCALE}${ROUTES.signIn}?${AUTH_QUERY.NEXT}=${encodeURIComponent(ROUTES.projects)}`,
      )

      section("Phase 3 — the project shell (#1, #2, #6)")
      await workspaceShell(account)

      section("Phase 2 — sign-out ends the session server-side (#3)")
      await signOutRoundTrip(account)
    },
    async () => {
      section("Teardown")
      // user.delete cascades to sessions and accounts (prisma/schema.prisma).
      await prisma.user.delete({ where: { id: account.id } })
      console.log(`  deleted ${account.email}`)
    },
  )

  printVerdict({ base: BASE })
}

/** Close the DB pool; a failure to do so is reported, not dropped. */
async function shutdown(): Promise<void> {
  try {
    await prisma.$disconnect()
  } catch (e) {
    console.error("[e2e-auth] prisma.$disconnect failed", e)
    process.exitCode = 1
  }
}

void main()
  .catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
  .then(shutdown)
