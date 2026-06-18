/**
 * POST /api/chat — chat-sdk streaming handler, authentication-gated.
 *
 * Slice 1: claude mode only, no domain tools, no MCP.
 * The full application layer (defineTool handlers, BnF MCP server, message
 * persistence, reattachable SSE) lands in slice 3.
 *
 * Note on withAuth: the standard AuthedHandler signature is
 *   (req, user, bouncer, ctx) => Promise<Response>
 * chat-sdk's handler takes only (request). The wrapper below satisfies the
 * AuthedHandler contract and delegates to the sdk handler — user/bouncer/ctx
 * are deliberately unused this slice (their sole purpose here is 401 for
 * anonymous callers). This comment intentionally documents the deviation.
 */
import { withAuth } from "@/app/api/_middleware"
import { createChatHandler } from "@alien/chat-sdk/next"
import { createToolRegistry } from "@alien/chat-sdk/claude"
import { env } from "@/lib/env"

// Registry with no tools and no MCP servers this slice.
// Both parameters are optional — an empty registry is valid per chat-sdk docs.
const sdkHandler = createChatHandler({
  claude: {
    apiKey: env.ANTHROPIC_API_KEY,
    system:
      "Vous êtes un assistant de constitution de corpus pour la Bibliothèque nationale de France. Cette itération ne dispose pas encore d'outils — répondez en français avec sobriété et expliquez à l'utilisateur que les outils du corpus arriveront bientôt.",
    tools: createToolRegistry(),
  },
})

export const POST = withAuth(async (req) => {
  return sdkHandler(req)
})

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
