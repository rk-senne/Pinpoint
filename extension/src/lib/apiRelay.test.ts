// @vitest-environment jsdom

/**
 * Unit tests for the MV3 content-script → service-worker API relay
 * (`lib/apiRelay.ts`). Covers:
 *   - base64 round-trips for binary payloads.
 *   - `FormData` serialisation / deserialisation (text + blob fields).
 *   - request-body serialisation rules (string / FormData / null / reject).
 *   - `handleRelayRequest` (SW side): origin + auth attachment, header
 *     forwarding, text vs. binary body handling, and network-error capture.
 *   - `relayFetch` (content-script side): message shape, `Response`
 *     reconstruction, and network-error rejection.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  RELAY_MESSAGE_TYPE,
  base64ToBytes,
  bytesToBase64,
  deserializeBody,
  deserializeFormData,
  handleRelayRequest,
  validateRelayRequest,
  isSerializedForm,
  relayFetch,
  responseFromRelay,
  serializeBody,
  serializeFormData,
  type RelayRequest,
  type RelayResponse,
} from './apiRelay';

describe('base64 codecs', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('handles a large payload without stack overflow', () => {
    const bytes = new Uint8Array(200_000).map((_v, i) => i % 256);
    const round = base64ToBytes(bytesToBase64(bytes));
    expect(round.length).toBe(bytes.length);
    expect(round[123_456]).toBe(123_456 % 256);
  });
});

describe('FormData serialisation', () => {
  it('serialises text fields verbatim and blob fields to base64', async () => {
    const form = new FormData();
    form.append('redactionRects', '[{"x":1}]');
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    form.append('image', blob, 'shot.png');

    const serialized = await serializeFormData(form);
    expect(isSerializedForm(serialized)).toBe(true);
    expect(serialized.fields).toHaveLength(2);

    const text = serialized.fields.find((f) => f.name === 'redactionRects');
    expect(text).toEqual({
      name: 'redactionRects',
      kind: 'text',
      value: '[{"x":1}]',
    });

    const image = serialized.fields.find((f) => f.name === 'image');
    expect(image).toMatchObject({
      name: 'image',
      kind: 'blob',
      type: 'image/png',
      filename: 'shot.png',
    });
  });

  it('round-trips a FormData through deserializeFormData', async () => {
    const form = new FormData();
    form.append('label', 'hello');
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    form.append('image', new Blob([bytes], { type: 'image/png' }), 'x.png');

    const rebuilt = deserializeFormData(await serializeFormData(form));
    expect(rebuilt.get('label')).toBe('hello');
    const rebuiltBlob = rebuilt.get('image') as File;
    expect(rebuiltBlob).toBeInstanceOf(Blob);
    expect(rebuiltBlob.type).toBe('image/png');
    const buf = new Uint8Array(await rebuiltBlob.arrayBuffer());
    expect(buf).toEqual(bytes);
  });
});

describe('serializeBody / deserializeBody', () => {
  it('passes strings through unchanged', async () => {
    expect(await serializeBody('{"a":1}')).toBe('{"a":1}');
    expect(deserializeBody('{"a":1}')).toBe('{"a":1}');
  });

  it('maps null/undefined to null', async () => {
    expect(await serializeBody(null)).toBeNull();
    expect(await serializeBody(undefined)).toBeNull();
    expect(deserializeBody(null)).toBeNull();
  });

  it('serialises FormData to a SerializedForm and back', async () => {
    const form = new FormData();
    form.append('k', 'v');
    const serialized = await serializeBody(form);
    expect(isSerializedForm(serialized)).toBe(true);
    const back = deserializeBody(serialized);
    expect(back).toBeInstanceOf(FormData);
    expect((back as FormData).get('k')).toBe('v');
  });

  it('rejects unsupported body types', async () => {
    await expect(
      serializeBody(new Uint8Array([1]) as unknown as BodyInit),
    ).rejects.toThrow(/string or FormData/);
  });
});

describe('handleRelayRequest (service-worker side)', () => {
  it('times out a hung request and reports it as a networkError', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('The operation timed out.')));
        }),
    );
    const res = await handleRelayRequest(
      { type: 'PP_API_FETCH', path: '/projects', method: 'GET', headers: {}, body: null } as never,
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveOrigin: () => 'http://localhost:3001',
        apiBase: '/api/v1',
        authTokenProvider: () => null,
        timeoutMs: 20,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.networkError).toMatch(/timed out/i);
  });

  const baseReq: RelayRequest = {
    type: RELAY_MESSAGE_TYPE,
    path: '/projects/by-url?url=http%3A%2F%2Fx.test%2F',
    method: 'GET',
    headers: { Accept: 'application/json' },
    body: null,
  };

  it('resolves URL from origin + apiBase + path and attaches the bearer', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ projectId: 'p1', pageId: 'pg1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await handleRelayRequest(baseReq, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveOrigin: () => 'http://localhost:3001',
      apiBase: '/api/v1',
      authTokenProvider: () => 'tok-123',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'http://localhost:3001/api/v1/projects/by-url?url=http%3A%2F%2Fx.test%2F',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-123',
    );
    // Bearer-only: ambient dashboard cookies must never ride along (they
    // would trigger the server's CSRF double-submit → 403 on mutations).
    expect(init.credentials).toBe('omit');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.bodyText)).toEqual({ projectId: 'p1', pageId: 'pg1' });
    expect(res.headers['content-type']).toBe('application/json');
  });

  it('does not override an Authorization header the caller already set', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const authProvider = vi.fn(() => 'should-not-be-used');
    await handleRelayRequest(
      { ...baseReq, headers: { Authorization: 'Bearer caller-token' } },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveOrigin: () => 'http://localhost:3001',
        apiBase: '/api/v1',
        authTokenProvider: authProvider,
      },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer caller-token',
    );
    expect(authProvider).not.toHaveBeenCalled();
  });

  it('returns a binary body as base64 for image content types', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const fetchImpl = vi.fn(async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const res = await handleRelayRequest(baseReq, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveOrigin: () => 'http://localhost:3001',
      apiBase: '/api/v1',
      authTokenProvider: () => null,
    });
    expect(res.bodyBase64).toBeDefined();
    expect(base64ToBytes(res.bodyBase64!)).toEqual(bytes);
    expect(res.bodyText).toBe('');
  });

  it('captures a thrown fetch as networkError rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    const res = await handleRelayRequest(baseReq, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveOrigin: () => 'http://localhost:3001',
      apiBase: '/api/v1',
      authTokenProvider: () => null,
    });
    expect(res.networkError).toBe('Failed to fetch');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
  });

  it('forwards a serialised FormData body to fetch as live FormData', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 201 }));
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), 'a.png');
    const serialized = await serializeBody(form);

    await handleRelayRequest(
      {
        type: RELAY_MESSAGE_TYPE,
        path: '/annotations/a1/screenshot',
        method: 'POST',
        headers: {},
        body: serialized,
        raw: true,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveOrigin: () => 'http://localhost:3001',
        apiBase: '/api/v1',
        authTokenProvider: () => 'tok',
      },
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('image')).toBeInstanceOf(Blob);
  });
});

describe('responseFromRelay (content-script side)', () => {
  it('reconstructs a JSON Response readable via .json()/.ok/.status', async () => {
    const relay: RelayResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      bodyText: '{"data":[1,2,3]}',
    };
    const res = responseFromRelay(relay);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [1, 2, 3] });
  });

  it('reconstructs a 204 without a body', async () => {
    const res = responseFromRelay({
      ok: true,
      status: 204,
      statusText: 'No Content',
      headers: {},
      bodyText: '',
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('reconstructs a binary Response from base64', async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const res = responseFromRelay({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png' },
      bodyText: '',
      bodyBase64: bytesToBase64(bytes),
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf).toEqual(bytes);
  });
});

describe('relayFetch (content-script client)', () => {
  it('rejects promptly when the caller aborts, even if the relay never answers', async () => {
    const ac = new AbortController();
    const pending = relayFetch('/health', { method: 'HEAD', signal: ac.signal }, {
      sendMessage: () => new Promise(() => {}),
    });
    ac.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('sends a well-formed RelayRequest and reconstructs the Response', async () => {
    const sendMessage = vi.fn(
      async (_msg: RelayRequest): Promise<RelayResponse> => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        bodyText: '{"ok":true}',
      }),
    );
    const res = await relayFetch(
      '/projects',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer abc', Accept: 'application/json' },
      },
      { sendMessage },
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0]![0];
    expect(msg.type).toBe(RELAY_MESSAGE_TYPE);
    expect(msg.path).toBe('/projects');
    expect(msg.method).toBe('GET');
    expect(msg.headers.Authorization).toBe('Bearer abc');
    expect(msg.body).toBeNull();
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serialises a FormData body before sending', async () => {
    const sendMessage = vi.fn(
      async (_msg: RelayRequest): Promise<RelayResponse> => ({
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: {},
        bodyText: '{}',
      }),
    );
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'a.png');
    await relayFetch(
      '/annotations/a1/screenshot',
      { method: 'POST', body: form, raw: true },
      { sendMessage },
    );
    const msg = sendMessage.mock.calls[0]![0];
    expect(isSerializedForm(msg.body)).toBe(true);
    expect(msg.raw).toBe(true);
  });

  it('rejects with the worker networkError', async () => {
    const sendMessage = vi.fn(
      async (): Promise<RelayResponse> => ({
        ok: false,
        status: 0,
        statusText: '',
        headers: {},
        bodyText: '',
        networkError: 'Failed to fetch',
      }),
    );
    await expect(
      relayFetch('/projects', { method: 'GET' }, { sendMessage }),
    ).rejects.toThrow('Failed to fetch');
  });

  it('normalises Headers and array header shapes', async () => {
    const sendMessage = vi.fn(
      async (_msg: RelayRequest): Promise<RelayResponse> => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        bodyText: '{}',
      }),
    );
    await relayFetch(
      '/x',
      { method: 'POST', headers: new Headers({ 'x-a': '1' }) },
      { sendMessage },
    );
    expect(sendMessage.mock.calls[0]![0].headers['x-a']).toBe('1');

    await relayFetch(
      '/y',
      { method: 'POST', headers: [['x-b', '2']] },
      { sendMessage },
    );
    expect(sendMessage.mock.calls[1]![0].headers['x-b']).toBe('2');
  });
});

describe('relay path / method validation (F6)', () => {
  const ORIGIN = 'http://localhost:3001';
  const BASE = '/api/v1';
  const mk = (path: string, method = 'GET'): RelayRequest => ({
    type: RELAY_MESSAGE_TYPE,
    path,
    method,
    headers: {},
    body: null,
  });

  it.each([
    '/projects',
    '/projects/abc/annotations?status=open',
    '/projects/by-url?url=https%3A%2F%2Fx.test%2Fa%2F..%2Fb',
    '/annotations/1/comments',
  ])('accepts %s', (path) => {
    expect(validateRelayRequest(mk(path), ORIGIN, BASE)).toBeNull();
  });

  it.each([
    ['dot segments', '/../../admin'],
    ['inner dot segments', '/projects/../auth/x'],
    ['lower-case encoded dots', '/projects/%2e%2e/x'],
    ['upper-case encoded dots', '/projects/%2E%2E/x'],
    ['mixed encoded dots', '/projects/.%2e/x'],
    ['backslash', '/projects\\..\\x'],
    ['encoded backslash', '/projects/%5Cx'],
    ['double slash', '//evil.test/x'],
    ['inner double slash', '/projects//x'],
    ['absolute URL', 'https://evil.test/x'],
    ['scheme-relative', '//evil.test'],
    ['no leading slash', 'projects'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['control chars', '/projects/\n/x'],
    ['empty', ''],
  ])('rejects %s', (_name, path) => {
    expect(validateRelayRequest(mk(path), ORIGIN, BASE)).not.toBeNull();
  });

  it('rejects methods outside GET/POST/PUT/PATCH/DELETE', () => {
    for (const m of ['TRACE', 'CONNECT', 'OPTIONS', 'HEAD', '', 'get ']) {
      expect(validateRelayRequest(mk('/projects', m), ORIGIN, BASE)).not.toBeNull();
    }
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'patch']) {
      expect(validateRelayRequest(mk('/projects', m), ORIGIN, BASE)).toBeNull();
    }
  });

  it('requires a resolvable origin and keeps the URL under apiBase + "/"', () => {
    expect(validateRelayRequest({ path: '/', method: 'GET' }, ORIGIN, BASE)).toBeNull();
    expect(validateRelayRequest(mk('/x'), ORIGIN, '/other')).toBeNull();
    expect(validateRelayRequest(mk('/x'), 'not a url', BASE)).not.toBeNull();
  });

  it('handleRelayRequest never calls fetch for a rejected request', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const res = await handleRelayRequest(mk('/../../secret'), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveOrigin: () => ORIGIN,
      apiBase: BASE,
      authTokenProvider: () => 'tok',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.networkError).toMatch(/rejected/);
  });

  it('handleRelayRequest rejects a disallowed method without fetching or reading the token', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const auth = vi.fn(() => 'tok');
    const res = await handleRelayRequest(mk('/projects', 'TRACE'), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveOrigin: () => ORIGIN,
      apiBase: BASE,
      authTokenProvider: auth,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(res.networkError).toMatch(/method/);
  });
});
