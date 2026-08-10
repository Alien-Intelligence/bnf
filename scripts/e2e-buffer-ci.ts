/**
 * scripts/e2e-buffer-ci.ts — CI wrapper around the real-agent buffer e2e.
 *
 * Makes `scripts/e2e-buffer.ts` a self-contained, repeatable harness instead of
 * a manual two-terminal ritual:
 *   1. If a server is already reachable at E2E_BASE_URL, reuse it (fast local
 *      loop). Otherwise spin up `next dev` on E2E_PORT and wait for /api/health.
 *   2. Run the e2e as a child process with E2E_CLEANUP=1 so the throwaway
 *      project is removed on the way out (no dev-DB accretion).
 *   3. Tear the server down (whole process group) whatever the outcome, and
 *      exit with the e2e's own exit code.
 *
 * Run:
 *   npm run e2e:buffer:ci
 *   # honours E2E_PORT (default 3940), E2E_MODEL, E2E_TURN_TIMEOUT_MS.
 *
 * The dev DB + BnF MCP + LLM gateway env still come from .env.local (loaded by
 * the npm script's --env-file-if-exists, inherited by both children).
 */
import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

const PORT = Number(process.env["E2E_PORT"] ?? 3940)
const BASE_URL = (process.env["E2E_BASE_URL"] ?? `http://localhost:${PORT}`).replace(/\/+$/, "")
/** How long to wait for `next dev` to answer /api/health before giving up. */
const BOOT_TIMEOUT_MS = Number(process.env["E2E_BOOT_TIMEOUT_MS"] ?? 120_000)

/** True once the server answers /api/health with ANY status (401 is fine — the
 *  route is auth-gated; reachability is all we need). */
async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { method: "GET", signal: AbortSignal.timeout(3_000) })
    return res.status > 0
  } catch {
    return false
  }
}

/** Spawn `next dev` in its own process group so we can kill the whole tree. */
function startServer(): ChildProcess {
  console.log(`[ci] starting next dev on :${PORT} …`)
  const child = spawn("npm", ["run", "dev"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  })
  return child
}

/** Kill the whole process group started by startServer(). */
function stopServer(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

/** Run the e2e as a child; resolve with its exit code. */
function runE2e(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--conditions",
        "react-server",
        "scripts/e2e-buffer.ts",
      ],
      {
        env: { ...process.env, E2E_BASE_URL: BASE_URL, E2E_CLEANUP: "1" },
        stdio: "inherit",
      },
    )
    child.on("exit", (code) => resolve(code ?? 1))
    child.on("error", (err) => {
      console.error(`[ci] failed to launch e2e: ${err.message}`)
      resolve(1)
    })
  })
}

async function main(): Promise<void> {
  let server: ChildProcess | null = null

  if (await reachable()) {
    console.log(`[ci] reusing server already reachable at ${BASE_URL}`)
  } else {
    server = startServer()
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    // Cache misses across sleeps are fine here — we are polling an external
    // process boot, bounded by BOOT_TIMEOUT_MS (CLAUDE_ERROR_PATTERNS §14).
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error("next dev exited before becoming reachable")
      if (await reachable()) break
      await sleep(1_000)
    }
    if (!(await reachable())) {
      stopServer(server)
      throw new Error(`server did not become reachable at ${BASE_URL} within ${BOOT_TIMEOUT_MS}ms`)
    }
    console.log(`[ci] server ready at ${BASE_URL}`)
  }

  let code = 1
  try {
    code = await runE2e()
  } finally {
    if (server) {
      console.log("[ci] stopping server …")
      stopServer(server)
    }
  }
  process.exit(code)
}

main().catch((err: unknown) => {
  console.error("[ci] ABORTED:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
