import createNextIntlPlugin from "next-intl/plugin"
import type { NextConfig } from "next"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // production Docker image runs `node server.js` without the full source tree
  // or a global `next` install. See Dockerfile + helm/DEPLOY.md.
  output: "standalone",
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
