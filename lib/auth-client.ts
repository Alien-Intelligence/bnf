"use client"

import { createAuthClient } from "better-auth/react"
import { genericOAuthClient } from "better-auth/client/plugins"

// Client-side Better Auth handle. Only used for the Alien Auth (Authentik) SSO
// flow — email/password sign-in still POSTs directly to /api/auth/sign-in/email
// via apiFetch (see app/[locale]/sign-in/client.tsx). No basePath: BnF is served
// at root, so the default `/api/auth` base is correct.
export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
})
