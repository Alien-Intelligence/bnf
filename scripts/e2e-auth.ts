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
import { prisma } from "@/lib/db"
import { AUTH_QUERY, ROUTES } from "@/lib/constants"
import { check, printVerdict, requireServer, section } from "./e2e/harness"

const BASE = resolveBase()
const PW = "TestPassword123!"

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
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PW, name: `e2e auth ${email}` }),
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
  const ok = got.status === 307 && got.location === expected
  check(name, ok, `expected 307 → ${expected}, got ${got.status} → ${got.location ?? "(no location)"}`)
}

async function main(): Promise<void> {
  await requireServer(BASE)

  section("Phase 1 — `/`, `/sign-in`, `/sign-up` follow the session (#4)")
  const account = await signUp()
  const { cookie } = account

  try {
    expectRedirect("2. GET / signed in → /projects", await page("/", cookie), ROUTES.projects)
    expectRedirect("3. GET /en signed in → /en/projects", await page("/en", cookie), `/en${ROUTES.projects}`)
    expectRedirect("4. GET /sign-in signed in → /projects", await page(ROUTES.signIn, cookie), ROUTES.projects)
    expectRedirect(
      "5. GET /sign-in?next=<in-app path> signed in → that path",
      await page(`${ROUTES.signIn}?${AUTH_QUERY.NEXT}=${encodeURIComponent("/projects/x/rechercher")}`, cookie),
      "/projects/x/rechercher",
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
      "8. GET /en/projects signed out → /en/sign-in?next=/projects (English, with next)",
      await page(`/en${ROUTES.projects}`, null),
      `/en${ROUTES.signIn}?${AUTH_QUERY.NEXT}=${encodeURIComponent(ROUTES.projects)}`,
    )
  } finally {
    section("Teardown")
    // user.delete cascades to sessions and accounts (prisma/schema.prisma).
    await prisma.user.delete({ where: { id: account.id } })
    console.log(`  deleted ${account.email}`)
  }

  printVerdict({ base: BASE })
}

main()
  .catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
