/**
 * Fetch routing plan — which rate bucket(s) a target upstream needs, and
 * whether to attach the partner-API bearer token.
 *
 * Split out of server.ts (which calls `server.listen()` at module scope) so
 * `planFor` is importable and unit-testable in isolation, without booting the
 * HTTP listener.
 */
import { config, isManifest, isPartnerApi } from "./config.js";
import { TokenBucket } from "./rate.js";

/** The rate buckets a request can be routed through, by name. */
export type BucketName = "global" | "manifest" | "external";

export interface Plan {
  /** Bucket(s) to acquire before sending, in order, by name. */
  acquire: BucketName[];
  /** Whether to attach a Bearer token (partner API only). */
  auth: boolean;
  /** Bucket(s) to freeze on a 429 from this upstream, by name. */
  penalize: BucketName[];
}

/**
 * Decide which bucket(s) + auth a target upstream needs.
 *
 * Manifests and the rest of the partner API are SEPARATE budgets per the BnF
 * agreement (40/min manifests, 1000/min everything else — confirmed
 * 2026-08-11): a manifest request acquires/penalizes ONLY the manifest
 * bucket. It never spends global tokens, and a manifest 429 never freezes
 * non-manifest partner traffic.
 *
 * (F5, prod incident 2026-08-11): the previous plan charged manifests against
 * BOTH buckets. That was latent while the shed valve never fired (F3), but
 * fixing F3 alone would have turned invisible queueing into a real hazard —
 * a single manifest 429 would freeze ALL partner traffic for up to 60s. F3
 * and this isolation land together for exactly that reason.
 */
export function planFor(target: URL): Plan {
  if (isPartnerApi(target)) {
    if (isManifest(target)) {
      return { acquire: ["manifest"], auth: true, penalize: ["manifest"] };
    }
    return { acquire: ["global"], auth: true, penalize: ["global"] };
  }
  // Ungated hosts (oai/catalogue/data.bnf.fr): politeness bucket, no auth, NOT
  // counted against either partner budget.
  return { acquire: ["external"], auth: false, penalize: ["external"] };
}

/** The live bucket instances, keyed by the names `planFor` returns. */
export const buckets: Record<BucketName, TokenBucket> = {
  global: new TokenBucket({ rpm: config.globalRpm, burst: config.globalBurst }),
  manifest: new TokenBucket({ rpm: config.manifestRpm, burst: config.manifestBurst }),
  external: new TokenBucket({ rpm: config.externalRpm, burst: config.externalBurst }),
};
