// lib/async/process-singleton.ts
// State a background drainer must hold ONCE per process. Next.js may evaluate a
// module more than once (instrumentation and route bundles, dev re-evaluation);
// module-level state would then exist per copy. State kept on globalThis under a
// registered symbol is found by every copy, so a second evaluation shares the
// one running guard instead of starting a second drainer beside it.
// Pure: imports nothing.

/**
 * The process-wide value registered under `key`, created on first use. A value
 * under `key` that `isValid` rejects is a collision with foreign state: it
 * throws rather than overwriting it.
 */
export function processSingleton<T>(
  key: symbol,
  create: () => T,
  isValid: (value: unknown) => value is T,
): T {
  const existing: unknown = Reflect.get(globalThis, key)
  if (existing === undefined) {
    const created = create()
    Reflect.set(globalThis, key, created)
    return created
  }
  if (!isValid(existing)) {
    throw new Error(`globalThis[${key.description ?? "symbol"}] holds a value of the wrong shape`)
  }
  return existing
}
