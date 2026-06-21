/**
 * Thin authenticated HTTP wrapper around the data cluster REST API.
 *
 * The cluster is reached via the backend proxy at
 *   {BACKEND_API_URL}/clusters/{CLUSTER_ID}/proxy
 * with a bearer token (the platform's `CLUSTER_BEARER_TOKEN`).
 *
 * All envs are read lazily — importing this module does not throw if
 * cluster envs are absent (the embed-only smoke test must still work).
 */
import { Agent, request, FormData, type Dispatcher } from "undici";
import { cluster } from "../env.js";

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

/** Default per-attempt timeout — long enough for a slow index, short enough to fail fast. */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transient = worth retrying: connection resets / "other side closed" /
 * timeouts (no HTTP status) and 502/503/504 from the proxy. A 4xx is the
 * caller's fault and never retried.
 */
function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export class ClusterHttp {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly dispatcher: Agent;

  constructor(opts: ClusterHttpOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? cluster.baseUrl()).replace(/\/+$/, "");
    this.authHeader = `Bearer ${opts.bearerToken ?? cluster.bearerToken()}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
    // Dedicated dispatcher with aggressive connection recycling. The cluster
    // proxy intermittently drops connections; a long-lived keep-alive pool
    // then hands back half-dead sockets that hang on the next request (a
    // fresh process uploads the same 10KB file in <1s while a worker reusing
    // a stale socket times out at 60s). Short keep-alive + per-request reset
    // means every call gets, and then releases, a clean connection.
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

  async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("POST", path, { json: body });
  }

  /**
   * Multipart POST. Takes a FACTORY (not a FormData) because a retry must
   * rebuild the body — an undici FormData / its underlying stream can only be
   * consumed once.
   */
  async postForm<T>(path: string, formFactory: () => FormData): Promise<T> {
    return this.send<T>("POST", path, { formFactory });
  }

  async deleteJson<T>(path: string): Promise<T> {
    return this.send<T>("DELETE", path);
  }

  /**
   * Like getJson but returns null on 404 instead of throwing. Useful for
   * "fetch by slug" probes where absence is an expected state.
   */
  async getJsonOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.getJson<T>(path);
    } catch (err) {
      if (err instanceof ClusterHttpError && err.status === 404) return null;
      throw err;
    }
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
        // 4xx is a permanent caller error — never retry. Everything else
        // (connection reset / "other side closed" / timeout / 5xx) is a
        // transient cluster blip: back off and try again.
        if (
          err instanceof ClusterHttpError &&
          err.status >= 400 &&
          err.status < 500
        ) {
          throw err;
        }
        if (attempt === this.attempts) break;
        const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
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
      // Close the connection after each request so a dropped/half-dead socket
      // is never reused on the next call.
      reset: true,
      // Hard ceiling per attempt — without this a stuck cluster connection
      // hangs the whole pg-boss batch (see CLAUDE_ERROR_PATTERNS.md §14).
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.body.text();
    if (isTransientStatus(res.statusCode)) {
      // Surface as a generic error so the retry loop treats it as transient.
      throw new Error(`cluster ${method} ${path} -> HTTP ${res.statusCode}`);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new ClusterHttpError(method, path, res.statusCode, text);
    }
    if (text.length === 0) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ClusterHttpError(
        method,
        path,
        res.statusCode,
        `non-JSON response: ${text.slice(0, 200)}`,
      );
    }
  }
}
