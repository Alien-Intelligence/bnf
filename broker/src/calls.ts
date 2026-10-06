/**
 * In-memory call log for the broker — every /fetch outcome, kept in a
 * fixed-size circular buffer and exportable as CSV via `GET /calls.csv`.
 *
 * Purpose: observe the ACTUAL rate-limiting behaviour (broker-shed 429s, real
 * BnF 429s + their Retry-After, freeze windows, per-bucket pressure, wait times)
 * without grepping logs. One row per call, oldest-first.
 *
 * Bounded by its capacity (`BNF_CALLS_LOG_SIZE`, default 200k rows ≈ a full
 * multi-hour job). In-memory only — a broker restart clears it; fetch
 * /calls.csv before recycling the pod if you need the history. Single-replica,
 * so no cross-pod merge to worry about.
 */
import type { BucketName } from "./plan.js";

/** One recorded broker call. */
export interface CallRecord {
  /** Epoch ms when the call completed. */
  ts: number;
  host: string;
  path: string;
  /** The status the broker returned to the caller (upstream status, or a
   *  synthetic 429-shed / 403-unclassified / 502 when the broker short-circuited). */
  status: number;
  /** The most specific bucket of the call's plan (plan.label); null for a
   *  request rejected before any bucket applied (`unclassified`). */
  bucket: BucketName | null;
  /** Whether a Bearer token was attached (partner API) or not (ungated host). */
  authed: boolean;
  /** ms spent waiting on the rate bucket(s) before sending (acquire wait). */
  waitMs: number;
  /** ms spent on the upstream fetch itself (0 when shed before sending). */
  fetchMs: number;
  /** Raw `Retry-After` header on a 429, or null. */
  retryAfter: string | null;
  /** Short tag: ok | shed | freeze | freeze_403 | remint | upstream_error |
   *  truncated_upstream | unclassified. */
  note: string;
  /** Every bucket the plan acquires, in order (e.g. manifest, presentation, global). */
  acquired: readonly BucketName[];
  /** The bucket that shed the request (note `shed`), else null. */
  shedBy: BucketName | null;
}

/**
 * The CSV columns. `acquired` and `shed_by` are APPENDED so every earlier
 * column keeps its position (the 2026-09-15 analysis scripts index by column).
 */
export const CALLS_CSV_HEADER =
  "timestamp_iso,epoch_ms,host,path,status,bucket,authed,wait_ms,fetch_ms,retry_after,note,acquired,shed_by";

function csvField(v: string | number | boolean): string {
  const s = String(v);
  // Quote when the field contains a comma, quote, or newline; double inner quotes.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A bounded ring of call records. Capacity 0 disables it (record is a no-op). */
export class CallLog {
  private readonly cap: number;
  private readonly buf: Array<CallRecord | undefined>;
  private writeIdx = 0;
  private count = 0;

  constructor(capacity: number) {
    this.cap = Math.max(0, Math.floor(capacity));
    this.buf = new Array<CallRecord | undefined>(this.cap);
  }

  /** Append a call record (O(1)). */
  record(rec: CallRecord): void {
    if (this.cap === 0) return;
    this.buf[this.writeIdx] = rec;
    this.writeIdx = (this.writeIdx + 1) % this.cap;
    if (this.count < this.cap) this.count += 1;
  }

  /** Number of rows currently held. */
  size(): number {
    return this.count;
  }

  /** Drop all rows (e.g. `?reset=1` to start a fresh capture window). */
  reset(): void {
    this.writeIdx = 0;
    this.count = 0;
    this.buf.fill(undefined);
  }

  /** All records, oldest-first. */
  private snapshot(): CallRecord[] {
    if (this.count === 0) return [];
    const ordered =
      this.count < this.cap
        ? this.buf.slice(0, this.count)
        : [...this.buf.slice(this.writeIdx), ...this.buf.slice(0, this.writeIdx)];
    return ordered.filter((r): r is CallRecord => r !== undefined);
  }

  /** Serialize the buffer to a CSV document (header + one row per call). */
  toCsv(): string {
    const lines = [CALLS_CSV_HEADER];
    for (const r of this.snapshot()) {
      lines.push(
        [
          new Date(r.ts).toISOString(),
          r.ts,
          csvField(r.host),
          csvField(r.path),
          r.status,
          r.bucket ?? "",
          r.authed,
          r.waitMs,
          r.fetchMs,
          csvField(r.retryAfter ?? ""),
          r.note,
          r.acquired.join("+"),
          r.shedBy ?? "",
        ].join(","),
      );
    }
    return lines.join("\n") + "\n";
  }
}
