import type { PolicyUser } from "@/models/users/schema"

export class AuthorizationError extends Error {
  constructor(message = "Forbidden") {
    super(message)
    this.name = "AuthorizationError"
  }
}

/**
 * The arguments a policy method takes, or `never` if the named member is not a
 * method. Makes `authorize()` structurally typed against the policy: passing a
 * Project loaded without its `shares` — which would silently deny access to
 * every shared member — is a compile error, not a runtime surprise.
 */
type PolicyArgs<P, A extends keyof P> = P[A] extends (...args: infer Args) => unknown
  ? Args
  : never

export interface Bouncer {
  with<P extends object>(
    PolicyClass: new (user: PolicyUser) => P,
  ): {
    authorize<A extends keyof P & string>(
      action: A,
      ...args: PolicyArgs<P, A>
    ): Promise<void>
  }
}

/**
 * The bouncer takes a PolicyUser — the User row plus their groupIds. A bare
 * User no longer compiles, which is what forces every policy through
 * lib/authz/project-access.ts.
 *
 * There is no `before()` admin bypass any more: admin is rule 2 inside
 * `projectAccessLevel`, so the bypass lives in exactly one place instead of
 * eleven. Policies that are not project-scoped (GroupPolicy, UserPolicy) carry
 * their own explicit admin checks.
 */
export function bouncer(user: PolicyUser): Bouncer {
  return {
    with(PolicyClass) {
      const policy = new PolicyClass(user) as Record<string, unknown>
      return {
        async authorize(action, ...args) {
          const method = policy[action] as
            | ((...a: unknown[]) => boolean | Promise<boolean>)
            | undefined
          if (typeof method !== "function") {
            throw new AuthorizationError(`No policy method "${String(action)}"`)
          }

          const allowed = await method.apply(policy, args)
          if (!allowed) throw new AuthorizationError()
        },
      }
    },
  }
}
