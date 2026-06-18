import type { User } from "@/lib/generated/prisma/client"

export class AuthorizationError extends Error {
  constructor(message = "Forbidden") {
    super(message)
    this.name = "AuthorizationError"
  }
}

export interface Bouncer {
  with<P extends object>(
    PolicyClass: new (user: User) => P,
  ): { authorize(action: keyof P & string, resource?: unknown): Promise<void> }
}

export function bouncer(user: User): Bouncer {
  return {
    with(PolicyClass) {
      const policy = new PolicyClass(user) as Record<string, unknown>
      return {
        async authorize(action, resource) {
          // before() provides an admin bypass: return true to short-circuit,
          // return undefined to fall through to the specific policy method.
          const beforeFn = policy["before"] as ((u: User) => boolean | undefined) | undefined
          if (beforeFn?.(user) === true) return

          const method = policy[action] as ((r: unknown) => boolean | Promise<boolean>) | undefined
          if (typeof method !== "function") {
            throw new AuthorizationError(`No policy method "${String(action)}"`)
          }

          const allowed = await method.call(policy, resource)
          if (!allowed) throw new AuthorizationError()
        },
      }
    },
  }
}
