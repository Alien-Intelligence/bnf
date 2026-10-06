-- AlterTable
ALTER TABLE "app_session" ADD COLUMN     "spawn_runs" INTEGER NOT NULL DEFAULT 0;

-- Backfill: the runs each session already made, so the per-session cap holds
-- across this deploy. A run is a spawn_research call that was not refused by
-- the fan-out caps (its output carries refused: "spawn_limit"); refusals never
-- counted as runs.
UPDATE "app_session" AS s
SET "spawn_runs" = runs.n
FROM (
  SELECT m."app_session_id" AS session_id, COUNT(*)::int AS n
  FROM "tool_call" AS tc
  JOIN "message" AS m ON m."id" = tc."message_id"
  WHERE tc."tool" = 'spawn_research'
    -- `spawn_limit` appears only in that refusal; matching the bare word
    -- covers the output stored as an object and as an escaped JSON string.
    AND (tc."output" IS NULL OR tc."output"::text NOT LIKE '%spawn\_limit%')
  GROUP BY m."app_session_id"
) AS runs
WHERE s."id" = runs.session_id;
