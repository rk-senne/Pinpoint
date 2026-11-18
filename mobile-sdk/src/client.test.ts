import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinpointClient, PinpointApiError } from '../src/client.js';

/**
 * These tests exercise the three concerns called out for the mobile SDK:
 *   1. request building (URL, method, body, JSON content-type)
 *   2. auth header selection (bearer token vs. API key)
 *   3. error paths (non-2xx → PinpointApiError, 401 → onAuthRequired, 204/empty → undefined)
 *
 * `fetch` is stubbed via `vi.stubGlobal` so no network access is required.
 */

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Build a minimal Response-like object the client understands. */
function makeResponse(
  body: unknown,
  { status = 200, headers = {} as Record<string, string> } = {},
): Response {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body || 'null') : body),
    text: async () => text,
  } as unknown as Response;
}

describe('PinpointClient', () => {
  let calls: FetchCall[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return makeResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('request building', () => {
    it('prefixes baseUrl + /api/v1 and uses the given method/path', async () => {
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      await client.getProject('proj-1');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.example.com/api/v1/projects/proj-1');
      expect(calls[0].init.method).toBe('GET');
      // No body → no Content-Type.
      expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
      expect(calls[0].init.body).toBeUndefined();
    });

    it('serializes a JSON body and sets Content-Type for mutating requests', async () => {
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      await client.createComment('ann-9', 'hello world');

      expect(calls[0].url).toBe('https://api.example.com/api/v1/annotations/ann-9/comments');
      expect(calls[0].init.method).toBe('POST');
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(calls[0].init.body).toBe(JSON.stringify({ body: 'hello world' }));
    });

    it('encodes query parameters and drops null/undefined values', async () => {
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      await client.listProjects({ search: 'bug', status: undefined as unknown as string });

      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/api/v1/projects');
      expect(url.searchParams.get('search')).toBe('bug');
      expect(url.searchParams.has('status')).toBe(false);
    });

    it('builds the oauth authorize URL with PKCE params', () => {
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      const authUrl = new URL(
        client.oauthUrl('google', { codeChallenge: 'abc', redirectUri: 'app://cb' }),
      );
      expect(authUrl.pathname).toBe('/api/v1/auth/oauth/google');
      expect(authUrl.searchParams.get('code_challenge')).toBe('abc');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('redirect_uri')).toBe('app://cb');
    });
  });

  describe('auth headers', () => {
    it('sends a Bearer Authorization header when a token is configured', async () => {
      const client = new PinpointClient({ baseUrl: 'https://api.example.com', token: 'tok-123' });
      await client.getProject('p');
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer tok-123');
      expect(headers['X-API-Key']).toBeUndefined();
    });

    it('sends an X-API-Key header when an apiKey is configured', async () => {
      const client = new PinpointClient({ baseUrl: 'https://api.example.com', apiKey: 'key-xyz' });
      await client.getProject('p');
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['X-API-Key']).toBe('key-xyz');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('setToken updates the bearer token used on later requests', async () => {
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      await client.getProject('p');
      expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBeUndefined();

      client.setToken('fresh-token');
      await client.getProject('p');
      expect((calls[1].init.headers as Record<string, string>)['Authorization']).toBe('Bearer fresh-token');
    });

    it('sends octet-stream content-type and auth header when uploading a screenshot', async () => {
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return makeResponse({ url: 'https://cdn/x.png' });
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com', token: 'tok' });
      const out = await client.uploadScreenshot('ann-1', new ArrayBuffer(4));
      const headers = calls[0].init.headers as Record<string, string>;
      expect(calls[0].url).toBe('https://api.example.com/api/v1/annotations/ann-1/screenshot');
      expect(headers['Content-Type']).toBe('application/octet-stream');
      expect(headers['Authorization']).toBe('Bearer tok');
      expect(out).toEqual({ url: 'https://cdn/x.png' });
    });
  });

  describe('error paths', () => {
    it('throws PinpointApiError with status and body on a non-2xx response', async () => {
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return makeResponse('not found', { status: 404 });
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });

      await expect(client.getProject('missing')).rejects.toBeInstanceOf(PinpointApiError);
      await expect(client.getProject('missing')).rejects.toMatchObject({
        status: 404,
        body: 'not found',
      });
    });

    it('invokes onAuthRequired exactly once per 401 before throwing', async () => {
      const onAuthRequired = vi.fn();
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return makeResponse('unauthorized', { status: 401 });
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com', onAuthRequired });

      await expect(client.getProject('x')).rejects.toBeInstanceOf(PinpointApiError);
      expect(onAuthRequired).toHaveBeenCalledTimes(1);
    });

    it('does not call onAuthRequired for non-401 errors', async () => {
      const onAuthRequired = vi.fn();
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return makeResponse('boom', { status: 500 });
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com', onAuthRequired });

      await expect(client.getProject('x')).rejects.toBeInstanceOf(PinpointApiError);
      expect(onAuthRequired).not.toHaveBeenCalled();
    });

    it('returns undefined for 204 No Content responses', async () => {
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return makeResponse('', { status: 204 });
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      await expect(client.deleteAnnotation('a1')).resolves.toBeUndefined();
      expect(calls[0].init.method).toBe('DELETE');
    });

    it('returns undefined when content-length is 0', async () => {
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return makeResponse('', { status: 200, headers: { 'content-length': '0' } });
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      await expect(client.markAllRead()).resolves.toBeUndefined();
    });

    it('PinpointApiError carries a descriptive message', () => {
      const err = new PinpointApiError(403, 'forbidden');
      expect(err.name).toBe('PinpointApiError');
      expect(err.message).toContain('403');
      expect(err.message).toContain('forbidden');
    });
  });

  describe('response shapes (real server envelopes)', () => {
    // Ground truth: responses captured from the live API. List endpoints return
    // `{ data, pagination }`; `GET /projects/:id` returns `{ project }`.
    function respondWith(body: unknown): void {
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return makeResponse(body);
      });
    }

    it('listProjects unwraps the { data, pagination } envelope', async () => {
      respondWith({
        data: [{ id: 'p1' }, { id: 'p2' }],
        pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      const projects = await client.listProjects();
      expect(projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    it('getProject unwraps the { project } envelope', async () => {
      respondWith({ project: { id: 'p9', name: 'Nine' } });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      const project = await client.getProject('p9');
      expect(project.id).toBe('p9');
      expect(project.name).toBe('Nine');
    });

    it('listAnnotations unwraps the { data } envelope', async () => {
      respondWith({
        data: [{ id: 'a1' }],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      const annotations = await client.listAnnotations('p1');
      expect(annotations.map((a) => a.id)).toEqual(['a1']);
    });

    it('listComments unwraps the { data } envelope', async () => {
      respondWith({
        data: [{ id: 'c1' }, { id: 'c2' }],
        pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      const comments = await client.listComments('a1');
      expect(comments.map((c) => c.id)).toEqual(['c1', 'c2']);
    });

    it('list readers tolerate a bare array from an older server build', async () => {
      respondWith([{ id: 'p1' }]);
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      const projects = await client.listProjects();
      expect(projects.map((p) => p.id)).toEqual(['p1']);
    });

    it('surfaces the canonical { error: { code, message } } envelope', async () => {
      fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return makeResponse(
          { error: { code: 'VALIDATION', message: 'projectId query param required.' } },
          { status: 400 },
        );
      });
      const client = new PinpointClient({ baseUrl: 'https://api.example.com' });
      await expect(client.getProject('x')).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION',
      });
      await expect(client.getProject('x')).rejects.toThrow(/projectId query param required/);
    });
  });
});
