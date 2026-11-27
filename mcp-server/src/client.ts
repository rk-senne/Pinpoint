// Pinpoint REST client for the MCP server (Mission C5).
//
// Zero runtime dependencies. Talks to the existing Pinpoint REST API over
// `fetch`, authenticating with a STANDARD org API key (reuses the A1 key
// model). The key is sent as `Authorization: Bearer <key>` — the shape the
// server's `apiKeyAuth` middleware accepts for standard keys.
//
// WIDGET KEYS ARE REJECTED CLIENT-SIDE: a `pk_widget_*` key is a
// project-scoped public submission credential, never a management credential.
// Presenting one here is almost always a mistake, and the server would reject
// it as a Bearer anyway (401) — we fail fast with a clear message instead.

/** Max characters of an upstream error body kept in thrown errors. */
const MAX_ERROR_BODY_CHARS = 300;

/** Thrown when configuration (URL / key) is invalid. */
export class PinpointConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinpointConfigError';
  }
}

/** Thrown when the REST API returns a non-2xx response. */
export class PinpointApiError extends Error {
  readonly body: string;
  constructor(
    readonly status: number,
    body: string,
  ) {
    // Upstream error bodies are untrusted text that ends up in an LLM context:
    // cap their size (PP-16).
    const safe = body.length > MAX_ERROR_BODY_CHARS ? `${body.slice(0, MAX_ERROR_BODY_CHARS)}…[truncated]` : body;
    super(`Pinpoint API error ${status}: ${safe}`);
    this.body = safe;
    this.name = 'PinpointApiError';
  }
}

export interface PinpointClientConfig {
  /** Base URL of the Pinpoint API, e.g. `https://pinpoint.example.com`. */
  apiUrl: string;
  /** A standard org API key (`pk_...`, NOT `pk_widget_...`). */
  apiKey: string;
  /** Overridable fetch (tests stub this). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ListFeedbackParams {
  projectId: string;
  status?: string;
  severity?: string;
  page?: number;
  limit?: number;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Validate configuration, rejecting widget keys up front. */
export function assertValidConfig(apiUrl: string, apiKey: string): void {
  let parsed: URL | null = null;
  try {
    parsed = apiUrl ? new URL(apiUrl) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new PinpointConfigError(
      'PINPOINT_API_URL must be an absolute https:// URL (http:// is allowed for localhost only).',
    );
  }
  // PP-16: the bearer key must never travel in cleartext to a remote host.
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new PinpointConfigError(
      'PINPOINT_API_URL must use https:// — plain http:// is only allowed for loopback hosts (localhost, 127.0.0.1, ::1).',
    );
  }
  if (!apiKey) {
    throw new PinpointConfigError('PINPOINT_API_KEY is required.');
  }
  if (apiKey.startsWith('pk_widget_')) {
    throw new PinpointConfigError(
      'PINPOINT_API_KEY looks like a widget key (pk_widget_…). Widget keys are ' +
        'public, project-scoped submission credentials and cannot be used to ' +
        'manage feedback. Use a standard API key (pk_…) instead.',
    );
  }
}

export class PinpointClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PinpointClientConfig) {
    assertValidConfig(config.apiUrl, config.apiKey);
    this.apiUrl = trimTrailingSlashes(config.apiUrl);
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  // --- Tools -------------------------------------------------------------

  /** list_projects — `GET /projects` (optional search/status filters). */
  async listProjects(params: { search?: string; status?: string } = {}): Promise<unknown> {
    const qs = buildQuery({ search: params.search, status: params.status });
    return this.request('GET', `/projects${qs}`);
  }

  /**
   * list_feedback — `GET /feedback?projectId=…`. The REST API filters by
   * `status` server-side; `severity` has no server filter, so we apply it
   * client-side on the returned page.
   */
  async listFeedback(params: ListFeedbackParams): Promise<unknown> {
    const qs = buildQuery({
      projectId: params.projectId,
      status: params.status,
      page: params.page,
      limit: params.limit,
    });
    const result = (await this.request('GET', `/feedback${qs}`)) as {
      data?: Array<Record<string, unknown>>;
      pagination?: unknown;
    };
    if (params.severity && Array.isArray(result.data)) {
      const filtered = result.data.filter((a) => a.severity === params.severity);
      return { ...result, data: filtered, severityFilteredClientSide: true };
    }
    return result;
  }

  /**
   * get_feedback — the REST API has no single-annotation GET, so we locate
   * the item within its project's feedback list and attach its comments
   * (and any captured diagnostics carried on the annotation).
   */
  async getFeedback(params: { id: string; projectId: string }): Promise<unknown> {
    const { id, projectId } = params;
    let page = 1;
    const limit = 100;
    let found: Record<string, unknown> | undefined;
    // Walk pages until we find the id or run out.
    for (;;) {
      const qs = buildQuery({ projectId, page, limit });
      const res = (await this.request('GET', `/feedback${qs}`)) as {
        data?: Array<Record<string, unknown>>;
        pagination?: { totalPages?: number };
      };
      const match = (res.data ?? []).find((a) => a.id === id);
      if (match) {
        found = match;
        break;
      }
      const totalPages = res.pagination?.totalPages ?? 1;
      if (page >= totalPages) break;
      page += 1;
    }
    if (!found) {
      throw new PinpointApiError(404, `Feedback ${id} not found in project ${projectId}.`);
    }
    const comments = (await this.request('GET', `/annotations/${encodeURIComponent(id)}/comments`)) as {
      data?: unknown[];
    };
    return {
      feedback: found,
      comments: comments.data ?? [],
      diagnostics: {
        console: found.consoleLogs ?? found.console ?? null,
        network: found.networkLogs ?? found.network ?? null,
        environment: found.environment ?? null,
      },
    };
  }

  /** update_feedback_status — `PUT /annotations/:id/status`. */
  async updateFeedbackStatus(params: { id: string; status: string }): Promise<unknown> {
    return this.request('PUT', `/annotations/${encodeURIComponent(params.id)}/status`, {
      status: params.status,
    });
  }

  /** add_comment — `POST /annotations/:id/comments`. */
  async addComment(params: { id: string; body: string }): Promise<unknown> {
    return this.request('POST', `/annotations/${encodeURIComponent(params.id)}/comments`, {
      body: params.body,
    });
  }

  // --- internals ---------------------------------------------------------

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.apiUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PinpointApiError(res.status, text);
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined;
    }
    return res.json();
  }
}

/** Build a `?a=b&c=d` query string, dropping null/undefined values. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/** Strip trailing '/' in linear time (a /\/+$/ regex backtracks on long runs). */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}
