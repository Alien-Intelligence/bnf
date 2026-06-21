/**
 * Track 3 embedder. The only embedding adapter we ship is RunPod bge-m3.
 *
 * `getEmbedder()` is a lazy factory so callers can construct one without
 * touching constructor args; tests can pass a custom instance directly.
 */
import { RunpodBgeM3 } from "./runpod.js";

export { RunpodBgeM3 } from "./runpod.js";
export type { RunpodBgeM3Options, EmbedOptions } from "./runpod.js";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export function getEmbedder(): Embedder {
  return new RunpodBgeM3();
}

export default RunpodBgeM3;
