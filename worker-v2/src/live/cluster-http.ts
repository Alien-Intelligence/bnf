/**
 * Self-contained authenticated HTTP transport for the data-cluster REST API,
 * vendored into worker-v2 (ported from V1 worker/src/cluster/http.ts).
 *
 * WHY VENDORED, not imported from worker/: this module's `request`, `Agent`, and
 * `FormData` MUST all come from the SAME undici instance. worker/ and worker-v2/
 * each have their own undici install, and undici's `request` serializes a
 * multipart body only when `body instanceof <its own> FormData`. A FormData built
 * with worker-v2's undici, passed to worker's `request`, fails that check → undici
 * drops the body → the request never goes out → the data-api never sees it → the
 * client times out (a multi-hour debugging rabbit hole, 2026-06-26). Keeping the
 * transport here guarantees one undici instance end to end.
 *
 * Reached via the platform proxy: {BACKEND_API_URL}/clusters/{CLUSTER_ID}/proxy
 * with the platform's CLUSTER_BEARER_TOKEN. Envs read lazily at construction.
 */
import { Agent, request, type Dispatcher, type FormData } from "undici";

export class ClusterHttpError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Cluster ${method} ${path} -> HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ClusterHttpError";
  }
}

export interface ClusterHttpOptions {
  baseUrl?: string;
  bearerToken?: string;
  /** Per-attempt hard timeout (ms). Default 60s. */
  timeoutMs?: number;
  /** Total attempts per call (incl. the first). Default 4. */
  attempts?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function required(name: string): string {
  const v = process.env[name];
  if (v == null || v.trim() === "") throw new Error(`Missing required env var ${name}`);
  return v.trim();
}

export class ClusterHttp {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly dispatcher: Agent;

  constructor(opts: ClusterHttpOptions = {}) {
    const base =
      opts.baseUrl ??
      `${required("BACKEND_API_URL").replace(/\/+$/, "")}/clusters/${required("CLUSTER_ID")}/proxy`;
    this.baseUrl = base.replace(/\/+$/, "");
    this.authHeader = `Bearer ${opts.bearerToken ?? required("CLUSTER_BEARER_TOKEN")}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
    // Aggressive connection recycling — the proxy intermittently drops sockets;
    // a stale keep-alive socket then hangs the next request. reset:true per call.
    this.dispatcher = new Agent({
      connect: { timeout: 10_000 },
      keepAliveTimeout: 500,
      keepAliveMaxTimeout: 500,
      pipelining: 0,
    });
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async getJson<T>(path: string): Promise<T> {
    return this.send<T>("GET", path);
  }

  async getJsonOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.getJson<T>(path);
    } catch (err) {
      if (err instanceof ClusterHttpError && err.status === 404) return null;
      throw err;
    }
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("POST", path, { json: body });
  }

  async deleteJson<T>(path: string): Promise<T> {
    return this.send<T>("DELETE", path);
  }

  /** Multipart POST. Takes a FACTORY because a retry must rebuild the body (an
   *  undici FormData / its stream is single-use). */
  async postForm<T>(path: string, formFactory: () => FormData): Promise<T> {
    return this.send<T>("POST", path, { formFactory });
  }

  private async send<T>(
    method: Dispatcher.HttpMethod,
    path: string,
    opts: { json?: unknown; formFactory?: () => FormData } = {},
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await this.sendOnce<T>(method, path, opts);
      } catch (err) {
        lastErr = err;
        if (err instanceof ClusterHttpError && err.status >= 400 && err.status < 500) {
          throw err; // 4xx = permanent caller error, never retry
        }
        if (attempt === this.attempts) break;
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(
          `[cluster] ${method} ${path} attempt ${attempt}/${this.attempts} failed (${
            err instanceof Error ? err.message : String(err)
          }), retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
      }
    }
    throw lastErr;
  }

  private async sendOnce<T>(
    method: Dispatcher.HttpMethod,
    path: string,
    opts: { json?: unknown; formFactory?: () => FormData },
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: this.authHeader,
      accept: "application/json",
    };
    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.formFactory !== undefined) {
      body = opts.formFactory(); // undici sets the multipart content-type itself
    }

    const res = await request(this.url(path), {
      method,
      headers,
      body,
      dispatcher: this.dispatcher,
      reset: true,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.body.text();
    if (isTransientStatus(res.statusCode)) {
      throw new Error(`cluster ${method} ${path} -> HTTP ${res.statusCode}`);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new ClusterHttpError(method, path, res.statusCode, text);
    }
    if (text.length === 0) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ClusterHttpError(method, path, res.statusCode, `non-JSON body: ${text.slice(0, 200)}`);
    }
  }
}
