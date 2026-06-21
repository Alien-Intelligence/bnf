# Pass 3 — Robustness Re-Test

Run date: 2026-06-20
Worker image: `bnf-ingest-worker:latest` (Pass 3 build)
Project: `pass3-robustness`
Ingest job id: `d1ea68d7-440d-4414-90f5-ec721065cced`

## Configuration
- `GALLICA_RPS=2`, `GALLICA_BURST=5` (token bucket defaults)
- `MAX_IMAGE_CANVASES=5`
- `BNF_DOC_PAGE_FAIL_RATIO` left at default (0.25)
- pg-boss retry: `retryLimit=3, retryDelay=30s, retryBackoff=true`

## ARK mix (12 items)
10 real Gallica ARKs + 2 fabricated:
`bpt6k58022059, bpt6k5427023p, bpt6k6258561z, bpt6k62084617, btv1b86158197,
bpt6k5738219s, btv1b53099849g, btv1b9015469h, btv1b9015550r, btv1b11600025m,
totally-not-a-real-ark, btv1b9015550r_nope`

## Wall-clock
- Parent ingest_job submitted: 12:00:30
- Parent ingest_job finalized `done`: 12:08:15
- Wall: **7m 45s** (DB column: 462.67 s)

## Outcome breakdown
| Status | Count | Notes |
|---|---|---|
| done | 0 | — see qualifier |
| failed | 5 | All `rate_limited_doc` after 3 attempts |
| skipped | 7 | mcp_unavailable (3) / holo_failed (3) / no_ocr_and_not_single_image (1) |

## Pass-3 specific signals
| Signal | Value |
|---|---|
| Peak `awaiting_retry` (DB sample) | 4 |
| `doc_job_transient_retry` log events | 10 |
| `rate_limited_doc` Transient throws | 28 (Fix 4 firing) |
| ECONNRESET log lines | 1 (vs. "storms" in Pass 2) |

## Fix verification
- **Fix 1 (token bucket):** No ECONNRESET storms; only a single residual one during early ramp. Pacing visibly held to ~2 RPS shared across 4-concurrent doc-jobs.
- **Fix 2 (submit-side jitter):** First doc-job entered `extracting` after a sub-second offset; subsequent docs picked up staggered (not visible in coarse 30 s sampling, but worker logs show interleaved per-ARK starts).
- **Fix 3 (`awaiting_retry` status):** New status surfaced in DB during transient retries (peak 4 concurrent), proving the row no longer lies about its state while pg-boss is holding it.
- **Fix 4 (per-doc page-fail ceiling):** Every `failed` row carried a `rate_limited_doc` error string with the exhausted/attempted ratio; doc-jobs bailed early instead of writing half-empty corpus rows.

## Verdict
**No** — we would not run 1500 docs unattended **at the current Gallica budget**.

Why: at `RPS=2, BURST=5` the worker is now well-behaved (no storms), but
Gallica's ALTO endpoint still issues frequent 429s under aggregate load
from 4 concurrent doc-jobs. Five out of five OCR-capable ARKs failed via
`rate_limited_doc`. The plumbing did its job — the failures are clean,
the parent finalizes, the cluster is not corrupted — but the success rate
of "good-faith" docs (1 in this run was healthy after dedup of skips) is
too low to leave unattended.

## Known limitations / Pass 4 candidates
1. **Tune `GALLICA_RPS` downward** — 1 RPS with burst 3 is likely the
   sustainable rate; the worker has the plumbing to honor it.
2. **Reduce doc-job concurrency** from 4 → 2 in the worker so each doc
   gets a fairer share of the bucket without further dropping RPS.
3. **Longer pg-boss retry delay** (currently 30 s × backoff). Gallica's
   anger window appears longer than that.
4. **Improve test ARK selection** — many of the 10 "real" ARKs in this
   mix are known-difficult (no OCR / holo-only). A real 1500-doc batch
   would have a healthier denominator.
5. **Cluster-side metric** — add a Qdrant point counter so the report
   can capture chunk delta even when 0 docs land (current run wrote 0
   chunks, so no delta to report).
