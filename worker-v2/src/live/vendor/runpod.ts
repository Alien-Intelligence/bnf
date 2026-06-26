/**
 * RunPod bge-m3 embedding adapter.
 *
 * Mirrors `data-pipelines/alienargo/services/embeddings/runpod.py`:
 *   POST https://api.runpod.ai/v2/{endpointId}/runsync
 *   body  { input: { model, input: [...texts], encoding_format: "float" } }
 *   resp  { status: "COMPLETED", output: { data: [{ embedding: number[] }, ...] } }
 *
 * Batches the input and runs batches with bounded concurrency, preserving
 * the order of the input list.
 */
import { request } from "undici";
import { runpod } from "./env.js";

export interface RunpodBgeM3Options {
  endpointId?: string;
  apiKey?: string;
  model?: string;
}

export interface EmbedOptions {
  batchSize?: number;
  concurrency?: number;
  /** Per-batch timeout (ms). RunPod runsync waits for cold-start + inference. */
  timeoutMs?: number;
}

interface RunpodResponse {
  status?: string;
  output?: {
    data?: Array<{ embedding?: unknown }>;
  };
  error?: unknown;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 300_000;

export class RunpodBgeM3 {
  private readonly endpointId: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: RunpodBgeM3Options = {}) {
    // Resolve env lazily so importing the class doesn't crash when only
    // some Track-3 envs are set (e.g. embed-only smoke test).
    this.endpointId = opts.endpointId ?? runpod.endpointId();
    this.apiKey = opts.apiKey ?? runpod.apiKey();
    this.model = opts.model ?? runpod.model();
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Build indexed batches so we can stitch results back in order.
    const batches: Array<{ index: number; texts: string[] }> = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      batches.push({ index: i / batchSize, texts: texts.slice(i, i + batchSize) });
    }

    const results: number[][][] = new Array(batches.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const myIdx = cursor++;
        if (myIdx >= batches.length) return;
        const batch = batches[myIdx]!;
        results[batch.index] = await this.embedBatch(batch.texts, timeoutMs);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, () => worker());
    await Promise.all(workers);

    // Flatten preserving original order.
    const out: number[][] = [];
    for (const batchResult of results) {
      for (const v of batchResult) out.push(v);
    }

    if (out.length !== texts.length) {
      throw new Error(
        `RunPod returned ${out.length} embeddings for ${texts.length} texts (mismatch)`,
      );
    }
    return out;
  }

  private async embedBatch(batch: string[], timeoutMs: number): Promise<number[][]> {
    const url = `https://api.runpod.ai/v2/${this.endpointId}/runsync`;
    const body = JSON.stringify({
      input: {
        model: this.model,
        input: batch,
        encoding_format: "float",
      },
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: ac.signal,
      });
    } catch (err) {
      throw new Error(
        `RunPod embed request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(
        `RunPod embed HTTP ${res.statusCode}: ${text.slice(0, 200)}`,
      );
    }

    let parsed: RunpodResponse;
    try {
      parsed = JSON.parse(text) as RunpodResponse;
    } catch {
      throw new Error(`RunPod embed: non-JSON response: ${text.slice(0, 200)}`);
    }

    if (parsed.status !== "COMPLETED") {
      throw new Error(
        `RunPod embed status=${parsed.status ?? "unknown"}: ${JSON.stringify(parsed).slice(0, 200)}`,
      );
    }

    const items = parsed.output?.data;
    if (!Array.isArray(items)) {
      throw new Error(`RunPod embed: missing output.data array`);
    }

    const out: number[][] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const emb = (item as { embedding?: unknown }).embedding;
      if (!Array.isArray(emb)) {
        throw new Error(`RunPod embed: item missing 'embedding' array`);
      }
      const floats = emb.map((x) => {
        const n = typeof x === "number" ? x : Number(x);
        if (!Number.isFinite(n)) {
          throw new Error(`RunPod embed: non-finite value in embedding`);
        }
        return n;
      });
      out.push(floats);
    }

    if (out.length !== batch.length) {
      throw new Error(
        `RunPod embed: batch size ${batch.length} but received ${out.length} embeddings`,
      );
    }
    return out;
  }
}
