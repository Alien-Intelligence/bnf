import "server-only"
import { z } from "zod"

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
})

// Strict at process boot — throws on any missing/invalid. NO defaults.
// (BNF_MCP_URL/TOKEN are intentionally NOT here this slice — slice 2 introduces them
// behind a lazy accessor so the dev server starts without them.)
export const env = envSchema.parse(process.env)
