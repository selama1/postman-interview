/**
 * Test HTTP client. Every exchange is recorded so a failing assertion can print the full
 * request/response (method, path, body, status, problem, x-request-id) — the request id lets
 * you grep the server logs for the exact request.
 *
 * Transport is pluggable: `fetchTransport` (default) talks HTTP to a real server; once an SDK
 * exists, an adapter Transport can route the same scenarios through it.
 */

export interface TestRequest {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | Array<string | number> | undefined> | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
}

export interface TestResponse<T = any> {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON, else the raw text (or null for empty). */
  body: T;
  requestId: string | null;
  ms: number;
}

export interface Exchange {
  req: TestRequest & { url: string };
  res?: TestResponse;
  error?: string;
}

export interface Transport {
  send(baseUrl: string, req: TestRequest): Promise<TestResponse>;
}

export function buildUrl(baseUrl: string, path: string, query?: TestRequest['query']): string {
  const u = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export const fetchTransport: Transport = {
  async send(baseUrl, req) {
    const t0 = performance.now();
    const hasBody = req.body !== undefined;
    const res = await fetch(buildUrl(baseUrl, req.path, req.query), {
      method: req.method,
      headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), accept: 'application/json', ...req.headers },
      body: hasBody ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    let body: unknown = text.length ? text : null;
    if (text.length && ct.includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body,
      requestId: res.headers.get('x-request-id'),
      ms: Math.round(performance.now() - t0),
    };
  },
};

const exchangeOf = new WeakMap<object, Exchange>();
/** The exchange that produced a response (used by matchers to print full context). */
export const lastExchangeFor = (res: TestResponse): Exchange | undefined => exchangeOf.get(res);

export class TestClient {
  readonly history: Exchange[] = [];

  constructor(
    readonly baseUrl: string,
    private readonly defaults: { headers?: Record<string, string> } = {},
    private readonly transport: Transport = fetchTransport,
  ) {}

  /** A client sharing history but with extra default headers (auth, tenant, ...). */
  withHeaders(headers: Record<string, string>): TestClient {
    const c = new TestClient(this.baseUrl, { headers: { ...this.defaults.headers, ...headers } }, this.transport);
    (c as { history: Exchange[] }).history = this.history;
    return c;
  }

  async request<T = any>(req: TestRequest): Promise<TestResponse<T>> {
    const full: TestRequest = { ...req, headers: { ...this.defaults.headers, ...req.headers } };
    const ex: Exchange = { req: { ...full, url: buildUrl(this.baseUrl, req.path, req.query) } };
    this.history.push(ex);
    try {
      ex.res = await this.transport.send(this.baseUrl, full);
      exchangeOf.set(ex.res, ex);
      return ex.res as TestResponse<T>;
    } catch (err) {
      ex.error = (err as Error).message;
      throw new Error(`${req.method} ${ex.req.url} failed: ${ex.error}`, { cause: err });
    }
  }

  get<T = any>(path: string, query?: TestRequest['query'], headers?: Record<string, string>) {
    return this.request<T>({ method: 'GET', path, query, headers });
  }
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>({ method: 'POST', path, body, headers });
  }
  put<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>({ method: 'PUT', path, body, headers });
  }
  patch<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>({ method: 'PATCH', path, body, headers });
  }
  delete<T = any>(path: string, headers?: Record<string, string>) {
    return this.request<T>({ method: 'DELETE', path, headers });
  }

  /** Last n exchanges, formatted for failure messages. */
  transcript(n = 3): string {
    return this.history.slice(-n).map(formatExchange).join('\n---\n');
  }
}

const clip = (v: unknown, max = 1500) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s && s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
};

export function formatExchange(ex: Exchange): string {
  const lines = [`→ ${ex.req.method} ${ex.req.url}`];
  if (ex.req.body !== undefined) lines.push(`  body: ${clip(ex.req.body)}`);
  if (ex.error) lines.push(`← ERROR ${ex.error}`);
  if (ex.res) {
    lines.push(`← ${ex.res.status} (${ex.res.ms} ms) x-request-id: ${ex.res.requestId ?? '-'}`);
    if (ex.res.body !== null) lines.push(`  body: ${clip(ex.res.body)}`);
  }
  return lines.join('\n');
}

/** Short unique suffix for data created against a shared (e2e) database. */
export const uniq = (prefix = 'x') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
