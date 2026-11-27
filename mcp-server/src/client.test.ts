import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PinpointClient,
  PinpointConfigError,
  PinpointApiError,
  assertValidConfig,
} from './client.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeResponse(
  body: unknown,
  { status = 200, headers = {} as Record<string, string> } = {},
): Response {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => map.get(n.toLowerCase()) ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body || 'null') : body),
    text: async () => text,
  } as unknown as Response;
}

const URL_BASE = 'https://pinpoint.example.com';
const KEY = 'pk_standard_deadbeef';

describe('assertValidConfig', () => {
  it('rejects a missing/invalid url', () => {
    expect(() => assertValidConfig('', KEY)).toThrow(PinpointConfigError);
    expect(() => assertValidConfig('not-a-url', KEY)).toThrow(PinpointConfigError);
  });

  it('rejects a missing key', () => {
    expect(() => assertValidConfig(URL_BASE, '')).toThrow(PinpointConfigError);
  });

  it('rejects a widget key with a clear message', () => {
    expect(() => assertValidConfig(URL_BASE, 'pk_widget_abc')).toThrow(/widget key/i);
  });

  it('PP-16: rejects cleartext http:// to a remote host but allows loopback', () => {
    expect(() => assertValidConfig('http://pinpoint.example.com', KEY)).toThrow(/https/);
    expect(() => assertValidConfig('http://10.0.0.5:3001', KEY)).toThrow(PinpointConfigError);
    expect(() => assertValidConfig('ftp://pinpoint.example.com', KEY)).toThrow(PinpointConfigError);
    for (const u of ['http://localhost:3001', 'http://127.0.0.1:3001', 'http://[::1]:3001', 'https://pinpoint.example.com']) {
      expect(() => assertValidConfig(u, KEY)).not.toThrow();
    }
  });

  it('PP-16: truncates long upstream error bodies', () => {
    const e = new PinpointApiError(500, 'x'.repeat(5000));
    expect(e.body.length).toBeLessThan(400);
    expect(e.message.length).toBeLessThan(450);
  });

  it('accepts a standard key + https url', () => {
    expect(() => assertValidConfig(URL_BASE, KEY)).not.toThrow();
  });
});

describe('PinpointClient', () => {
  let calls: FetchCall[];
  let fetchMock: ReturnType<typeof vi.fn>;

  function client(resp: (c: FetchCall) => Response = () => makeResponse({ data: [] })) {
    fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { url, init };
      calls.push(call);
      return resp(call);
    });
    return new PinpointClient({ apiUrl: URL_BASE, apiKey: KEY, fetchImpl: fetchMock as unknown as typeof fetch });
  }

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it('constructor rejects a widget key', () => {
    expect(
      () => new PinpointClient({ apiUrl: URL_BASE, apiKey: 'pk_widget_x' }),
    ).toThrow(PinpointConfigError);
  });

  it('sends Authorization: Bearer <key> and never the widget header', async () => {
    const c = client();
    await c.listProjects();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(calls[0].url).toBe(`${URL_BASE}/api/v1/projects`);
  });

  it('list_projects forwards search + status query params', async () => {
    const c = client();
    await c.listProjects({ search: 'bug', status: 'active' });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/api/v1/projects');
    expect(u.searchParams.get('search')).toBe('bug');
    expect(u.searchParams.get('status')).toBe('active');
  });

  it('list_feedback hits /feedback with projectId + status', async () => {
    const c = client(() => makeResponse({ data: [{ id: 'a', severity: 'major' }], pagination: {} }));
    await c.listFeedback({ projectId: 'p1', status: 'active', page: 2, limit: 50 });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/api/v1/feedback');
    expect(u.searchParams.get('projectId')).toBe('p1');
    expect(u.searchParams.get('status')).toBe('active');
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.searchParams.get('limit')).toBe('50');
  });

  it('list_feedback filters severity client-side', async () => {
    const c = client(() =>
      makeResponse({
        data: [
          { id: 'a', severity: 'major' },
          { id: 'b', severity: 'minor' },
        ],
        pagination: {},
      }),
    );
    const res = (await c.listFeedback({ projectId: 'p1', severity: 'minor' })) as {
      data: Array<{ id: string }>;
      severityFilteredClientSide?: boolean;
    };
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe('b');
    expect(res.severityFilteredClientSide).toBe(true);
  });

  it('get_feedback locates the item and attaches comments + diagnostics', async () => {
    const c = client((call) => {
      if (call.url.includes('/feedback')) {
        return makeResponse({
          data: [{ id: 'f1', severity: 'major', environment: { browserFamily: 'chrome' }, consoleLogs: ['x'] }],
          pagination: { totalPages: 1 },
        });
      }
      if (call.url.includes('/comments')) {
        return makeResponse({ data: [{ id: 'c1', body: 'hi' }] });
      }
      return makeResponse({});
    });
    const res = (await c.getFeedback({ id: 'f1', projectId: 'p1' })) as {
      feedback: { id: string };
      comments: unknown[];
      diagnostics: { console: unknown; environment: unknown };
    };
    expect(res.feedback.id).toBe('f1');
    expect(res.comments).toHaveLength(1);
    expect(res.diagnostics.console).toEqual(['x']);
    expect(res.diagnostics.environment).toEqual({ browserFamily: 'chrome' });
  });

  it('get_feedback throws 404 when the item is absent', async () => {
    const c = client((call) => {
      if (call.url.includes('/feedback')) {
        return makeResponse({ data: [], pagination: { totalPages: 1 } });
      }
      return makeResponse({});
    });
    await expect(c.getFeedback({ id: 'missing', projectId: 'p1' })).rejects.toBeInstanceOf(
      PinpointApiError,
    );
  });

  it('update_feedback_status PUTs /annotations/:id/status', async () => {
    const c = client(() => makeResponse({ annotation: { id: 'f1', status: 'resolved' } }));
    await c.updateFeedbackStatus({ id: 'f1', status: 'resolved' });
    expect(calls[0].url).toBe(`${URL_BASE}/api/v1/annotations/f1/status`);
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.body).toBe(JSON.stringify({ status: 'resolved' }));
  });

  it('add_comment POSTs /annotations/:id/comments', async () => {
    const c = client(() => makeResponse({ comment: { id: 'c1' } }, { status: 201 }));
    await c.addComment({ id: 'f1', body: 'looks good' });
    expect(calls[0].url).toBe(`${URL_BASE}/api/v1/annotations/f1/comments`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ body: 'looks good' }));
  });

  it('throws PinpointApiError on non-2xx', async () => {
    const c = client(() => makeResponse('nope', { status: 403 }));
    await expect(c.listProjects()).rejects.toMatchObject({ status: 403, body: 'nope' });
  });

  it('returns undefined for 204 responses', async () => {
    const c = client(() => makeResponse('', { status: 204 }));
    await expect(c.updateFeedbackStatus({ id: 'f', status: 'active' })).resolves.toBeUndefined();
  });
});

describe('trimTrailingSlashes', () => {
  it('strips any number of trailing slashes in linear time', async () => {
    const { trimTrailingSlashes } = await import('./client.js');
    expect(trimTrailingSlashes('https://a.example///')).toBe('https://a.example');
    expect(trimTrailingSlashes('https://a.example')).toBe('https://a.example');
    const long = 'https://a.example' + '/'.repeat(200_000) + 'x';
    const t0 = Date.now();
    expect(trimTrailingSlashes(long)).toBe(long);
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
