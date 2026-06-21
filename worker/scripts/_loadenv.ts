/**
 * Tiny .env loader used by Track-2 scripts so we don't pull dotenv in
 * just for the sandbox. Reads ./.env relative to the cwd, applies
 * KEY=VALUE lines to process.env (only if not already set).
 *
 * Quoted values are unwrapped; lines starting with `#` and blank lines
 * are ignored. Anything fancier (multiline, expansion) is out of scope.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), ".env");
if (existsSync(path)) {
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
