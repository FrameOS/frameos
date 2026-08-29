// The one thing every tool does: an HTTP call to the FrameOS Cloud API with
// a personal API token. Nothing here knows what a frame or a scene is —
// that stays in the routes; this only speaks bearer + JSON + the API's
// `{error, ...}` refusal shape, and turns a refusal into a CloudApiError
// the tool layer can explain.

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type FrameosCloudClientOptions = {
  /** Origin of the cloud API, e.g. https://cloud.frameos.net */
  baseUrl: string;
  /** Extra headers on every request (the remote host forwards the caller's IP). */
  headers?: Record<string, string> | undefined;
  /** Custom fetch — tests and the in-process host inject theirs. */
  fetch?: FetchLike | undefined;
  /** The personal API token (fc_api_… / fc_apiro_…). */
  token: string;
  /** Sent as User-Agent. */
  userAgent?: string | undefined;
};

export type RequestOptions = {
  body?: unknown;
  /** application/json when `body` is set, unless overridden. */
  contentType?: string | undefined;
  headers?: Record<string, string> | undefined;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  /** Raw body bytes (uploads); wins over `body`. */
  raw?: Uint8Array | FormData | undefined;
  signal?: AbortSignal | undefined;
};

export class CloudApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, unknown>,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`${method} ${path} → ${status} ${code}`);
  }
}

export class FrameosCloudClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Record<string, string>;
  private readonly userAgent: string;

  constructor(options: FrameosCloudClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.extraHeaders = options.headers ?? {};
    this.userAgent = options.userAgent ?? "frameos-cloud-mcp";
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      "user-agent": this.userAgent,
      ...this.extraHeaders,
      ...(options.headers ?? {}),
    };
    let body: BodyInit | undefined;
    if (options.raw !== undefined) {
      body = options.raw as BodyInit;
      if (options.contentType) {
        headers["content-type"] = options.contentType;
      }
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = options.contentType ?? "application/json";
    }
    const init: RequestInit = { headers, method };
    if (body !== undefined) {
      init.body = body;
    }
    if (options.signal) {
      init.signal = options.signal;
    }
    const response = await this.fetchImpl(this.url(path, options.query), init);
    if (!response.ok) {
      throw await this.toError(response, method, path);
    }
    return response;
  }

  async json<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.request(method, path, options);
    const text = await response.text();
    if (!text) {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CloudApiError(
        response.status,
        "invalid_json",
        { body: text.slice(0, 500) },
        method,
        path,
      );
    }
  }

  async bytes(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ bytes: Uint8Array; contentType: string; headers: Headers }> {
    const response = await this.request(method, path, {
      ...options,
      headers: { accept: "*/*", ...(options.headers ?? {}) },
    });
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      headers: response.headers,
    };
  }

  /**
   * Reads an NDJSON stream line by line, calling `onEvent` for each parsed
   * object, until the stream ends, `until` returns true, or the signal fires.
   */
  async ndjson(
    method: string,
    path: string,
    options: RequestOptions & {
      onEvent: (event: Record<string, unknown>) => void;
      until?: ((event: Record<string, unknown>) => boolean) | undefined;
    },
  ): Promise<void> {
    const response = await this.request(method, path, {
      ...options,
      headers: { accept: "application/x-ndjson", ...(options.headers ?? {}) },
    });
    if (!response.body) {
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    // The signal must end a read that is blocked on a quiet stream too, not
    // only the request itself — a turn that is thinking sends nothing.
    const onAbort = () => void reader.cancel().catch(() => undefined);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) {
            let event: Record<string, unknown> | undefined;
            try {
              event = JSON.parse(line) as Record<string, unknown>;
            } catch {
              event = undefined;
            }
            if (event) {
              options.onEvent(event);
              if (options.until?.(event)) {
                await reader.cancel().catch(() => undefined);
                return;
              }
            }
          }
          newline = buffered.indexOf("\n");
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      reader.releaseLock?.();
    }
  }

  private async toError(
    response: Response,
    method: string,
    path: string,
  ): Promise<CloudApiError> {
    let payload: Record<string, unknown> = {};
    const text = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      if (text) {
        payload = { body: text.slice(0, 500) };
      }
    }
    const code =
      typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    const { error: _error, ...details } = payload;
    return new CloudApiError(response.status, code, details, method, path);
  }
}
