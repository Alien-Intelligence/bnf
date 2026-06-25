/**
 * In-memory call log for the broker — every upstream /fetch outcome, kept in a
 * fixed-size circular buffer and exportable as CSV via `GET /calls.csv`.
 *
 * Purpose: observe the ACTUAL rate-limiting behaviour (broker-shed 429s, real
 * BnF 429s + their Retry-After, freeze windows, per-bucket pressure, wait times)
 * without grepping logs. One row per call, oldest-first.
 *
 * Bounded by `BNF_CALLS_LOG_SIZE` (default 200k rows ≈ a full multi-hour job).
 * It's in-memory only — a broker restart clears it; fetch /calls.csv before
 * recycling the pod if you need the history. Single-replica, so no cross-pod
 * merge to worry about.
 */
import { config } from "./config.js";

/** One recorded broker call. */
export interface CallRecord {
  /** Epoch ms when the call completed. */
  ts: number;
  host: string;
  path: string;
  /** The status the broker returned to the caller (upstream status, or a
   *  synthetic 429-shed / 502 when the broker short-circuited). */
  status: number;
  /** Which rate bucket governed it: "global" | "manifest" | "external". */
  bucket: string;
  /** Whether a Bearer token was attached (partner API) or not (ungated host). */
  authed: boolean;
  /** ms spent waiting on the rate bucket(s) before sending (acquire wait). */
  waitMs: number;
  /** ms spent on the upstream fetch itself (0 when shed before sending). */
  fetchMs: number;
  /** Raw `Retry-After` header on a 429, or null. */
  retryAfter: string | null;
  /** Short tag: ok | shed | freeze | freeze_403 | remint | upstream_error | token_error. */
  note: string;
}

const cap = Math.floor(config.callsLogSize);
const enabled = cap > 0;
const buf: (CallRecord | undefined)[] = enabled ? new Array(cap) : [];
let writeIdx = 0;
let count = 0;

/** Append a call record (O(1)); silently no-ops when disabled (cap=0). */
export function recordCall(rec: CallRecord): void {
  if (!enabled) return;
  buf[writeIdx] = rec;
  writeIdx = (writeIdx + 1) % cap;
  if (count < cap) count += 1;
}

/** All records, oldest-first. */
function snapshot(): CallRecord[] {
  if (!enabled || count === 0) return [];
  const out =
    count < cap
      ? buf.slice(0, count)
      : [...buf.slice(writeIdx), ...buf.slice(0, writeIdx)];
  return out as CallRecord[];
}

/** Number of rows currently held. */
export function callCount(): number {
  return count;
}

/** Drop all rows (e.g. `?reset=1` to start a fresh capture window). */
export function resetCalls(): void {
  writeIdx = 0;
  count = 0;
}

const HEADER =
  "timestamp_iso,epoch_ms,host,path,status,bucket,authed,wait_ms,fetch_ms,retry_after,note";

function csvField(v: string | number | boolean): string {
  const s = String(v);
  // Quote when the field contains a comma, quote, or newline; double inner quotes.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize the buffer to a CSV document (header + one row per call). */
export function toCsv(): string {
  const rows = snapshot();
  const lines = [HEADER];
  for (const r of rows) {
    lines.push(
      [
        new Date(r.ts).toISOString(),
        r.ts,
        csvField(r.host),
        csvField(r.path),
        r.status,
        r.bucket,
        r.authed,
        r.waitMs,
        r.fetchMs,
        csvField(r.retryAfter ?? ""),
        r.note,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
