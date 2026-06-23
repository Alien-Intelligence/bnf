import { execSync } from "node:child_process"
import { createRequire } from "node:module"
import createNextIntlPlugin from "next-intl/plugin"
import type { NextConfig } from "next"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const pkg = createRequire(import.meta.url)("./package.json") as { version: string }

// Build-time git short SHA for the in-app version chip. Prefer an explicit
// GIT_SHA build arg (set it in the Docker/CI build where `.git` is absent);
// otherwise read the local working tree. Never fail the build over it.
function gitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.trim()
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
  } catch {
    return ""
  }
}

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // production Docker image runs `node server.js` without the full source tree
  // or a global `next` install. See Dockerfile + helm/DEPLOY.md.
  output: "standalone",
  // Surfaced as a discreet version chip in the workspace header so the running
  // build is identifiable when debugging. NEXT_PUBLIC_* → inlined client-side.
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_GIT_SHA: gitSha(),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "gallica.bnf.fr",
      },
    ],
  },
}

export default withNextIntl(nextConfig)
