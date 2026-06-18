export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  // Defer the import so this file doesn't pull node-only modules into edge runtimes.
  const { startReaper } = await import("@/lib/agent/runtime/reaper")
  startReaper()
}
