/**
 * Fetch routing plan — which rate buckets a target upstream spends, which one a
 * 429 freezes, and whether the partner-API bearer is attached.
 *
 * The model is the BnF INGESTION subscription (ai-memories/tech/repos/bnf/
 * feedback-2026-09-29, Track D): one GLOBAL per-minute cap over every partner
 * API, one per-minute quota PER API (Presentation, Image, legacy Gallica-IIIF,
 * catalogue, …), the per-IP MANIFEST sub-limit, and a politeness bucket for the
 * ungated hosts. Pure: no env, no I/O — server.ts hands in the partner host and
 * the configured rates, so every rule here is unit-tested without booting.
 */
import { TokenBucket, type TokenBucketOptions } from "./rate.js";

/** One bucket per BnF partner API of the subscription. */
export const API_BUCKETS = [
  "presentation",
  "image",
  "iiifLegacy",
  "catalogue",
  "gallicaSru",
  "grapheData",
  "datePeriodique",
  "documentTdm",
] as const;
export type ApiBucket = (typeof API_BUCKETS)[number];

/** Every bucket the broker runs, once — the config reads a rate for each. */
export const BUCKET_NAMES = ["global", "manifest", "external", ...API_BUCKETS] as const;
export type BucketName = (typeof BUCKET_NAMES)[number];

/**
 * BnF partner APIs by path prefix on the partner host, the version segment
 * excluded so a version bump (`/presentation/iiif/gallica/1.0.1/…`) still
 * classifies. Taken from the BnF Swaggers (2026-09-30, ClientData/BNF). The
 * prefixes are disjoint, so the first match is the only match.
 */
export const PARTNER_API_PREFIXES: ReadonlyArray<{ prefix: string; bucket: ApiBucket }> = [
  { prefix: "/presentation/iiif/gallica/", bucket: "presentation" },
  { prefix: "/image/iiif/gallica/", bucket: "image" },
  { prefix: "/iiif/", bucket: "iiifLegacy" },
  { prefix: "/catalogueservice-cons/", bucket: "catalogue" },
  { prefix: "/recherche/sru/gallica/", bucket: "gallicaSru" },
  { prefix: "/graphe/data/", bucket: "grapheData" },
  { prefix: "/date/periodique/gallica/", bucket: "datePeriodique" },
  { prefix: "/document/tdm/gallica/", bucket: "documentTdm" },
];

/** A IIIF Presentation manifest, on the new Presentation API or the legacy combined one. */
const MANIFEST_PATH = /\/presentation\/v\d+\/.*\/manifest\.json$/;

export type Plan =
  | {
      kind: "send";
      /** Buckets to acquire before sending, most specific first, global last. */
      acquire: BucketName[];
      /** Whether to attach a Bearer token (partner API only). */
      auth: boolean;
      /** The bucket a 429 (or an ungated 403) from this upstream freezes. */
      penalize: BucketName;
      /** The most specific bucket — the `bucket` column of calls.csv. */
      label: BucketName;
    }
  | { kind: "reject"; reason: "unclassified_partner_path" };

/** The API bucket a partner-host path belongs to, or null when it matches no API. */
export function apiBucketFor(pathname: string): ApiBucket | null {
  for (const { prefix, bucket } of PARTNER_API_PREFIXES) {
    if (pathname.startsWith(prefix)) return bucket;
  }
  return null;
}

/**
 * The plan for one upstream URL.
 *
 * - Partner host, known API: acquire `[api, global]`, freeze `api` on a 429.
 *   A manifest takes the manifest sub-bucket first and a 429 freezes only it
 *   (a per-IP limit, so it applies on the legacy and the new API alike).
 *   Acquire order is most specific → global, so a request waiting on a scarce
 *   API bucket holds no global token and global stays FIFO across APIs.
 * - Partner host, unknown path: REJECT. Charging a default bucket would be a
 *   silent fallback, and sending on `global` alone could breach an API quota
 *   we do not model.
 * - Ungated host: the politeness bucket, no bearer.
 *
 * A 429 never freezes `global`: BnF does not say which quota tripped, and a
 * global freeze on, say, an Image 429 stalls every API (the F5 hazard). If the
 * global quota is the one tripping, each API bucket freezes itself after at
 * most one 429 per clock window, and `global` itself runs below the quota.
 */
export function planFor(target: URL, partnerApiHost: string): Plan {
  if (target.host !== partnerApiHost) {
    return { kind: "send", acquire: ["external"], auth: false, penalize: "external", label: "external" };
  }
  const api = apiBucketFor(target.pathname);
  if (api === null) return { kind: "reject", reason: "unclassified_partner_path" };
  if (MANIFEST_PATH.test(target.pathname)) {
    return { kind: "send", acquire: ["manifest", api, "global"], auth: true, penalize: "manifest", label: "manifest" };
  }
  return { kind: "send", acquire: [api, "global"], auth: true, penalize: api, label: api };
}

/** One bucket's configured pace. */
export interface BucketRate {
  rpm: number;
  burst: number;
}

/** Injectable clocks shared by every bucket (tests drive them; prod uses the defaults). */
export type BucketClock = Pick<TokenBucketOptions, "now" | "wallNow" | "sleep">;

/**
 * One live TokenBucket per bucket name, all on the same clock (acquireAll
 * compares one deadline across them). The literal is exhaustive by type: a
 * bucket added to BUCKET_NAMES without a line here does not compile.
 */
export function createBuckets(
  rates: Readonly<Record<BucketName, BucketRate>>,
  clock: BucketClock = {},
): Record<BucketName, TokenBucket> {
  const make = (name: BucketName): TokenBucket => new TokenBucket({ ...rates[name], ...clock });
  return {
    global: make("global"),
    manifest: make("manifest"),
    external: make("external"),
    presentation: make("presentation"),
    image: make("image"),
    iiifLegacy: make("iiifLegacy"),
    catalogue: make("catalogue"),
    gallicaSru: make("gallicaSru"),
    grapheData: make("grapheData"),
    datePeriodique: make("datePeriodique"),
    documentTdm: make("documentTdm"),
  };
}
