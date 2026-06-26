/**
 * Live Embedder — wraps V1's proven RunPod bge-m3 adapter (`RunpodBgeM3`).
 *
 * V1's adapter already exposes exactly the shape the V2 port wants:
 * `embed(texts: string[]) → Promise<number[][]>`, order-preserving, batched with
 * bounded concurrency, with a hard mismatch check. So this is a thin pass-through
 * that adds the one thing the V2 port requires that V1 didn't model: `dim`.
 *
 * bge-m3 is a 1024-dimensional model (BAAI/bge-m3). The V2 embed stage writes
 * `dim` alongside the vectors so the register stage / cluster knows the vector
 * width without re-deriving it. We assert the live vectors match the declared
 * dim on first embed so a model swap that changes the width can't silently ship
 * mislabelled vectors.
 */
import { RunpodBgeM3 } from "./vendor/runpod.js";
import type { Embedder } from "../ports.js";

/** bge-m3 embedding width. */
export const BGE_M3_DIM = 1024;

export class LiveEmbedder implements Embedder {
  readonly dim = BGE_M3_DIM;
  private readonly inner: RunpodBgeM3;

  constructor(inner?: RunpodBgeM3) {
    this.inner = inner ?? new RunpodBgeM3();
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors = await this.inner.embed(texts);
    // Guard against a silent model/width change: the declared dim is what the
    // register stage records, so a mismatch must fail loudly, not ship.
    if (vectors.length > 0 && vectors[0]!.length !== this.dim) {
      throw new Error(
        `Embedder dim mismatch: declared ${this.dim}, got ${vectors[0]!.length} ` +
          `(model width changed — update LiveEmbedder.dim)`,
      );
    }
    return vectors;
  }
}
