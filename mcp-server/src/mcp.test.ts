import { describe, expect, it, vi } from 'vitest';
import { PinpointClient } from './client.js';
import { TOOLS, listTools, callTool, findTool, ToolValidationError } from './tools.js';
import { handleRpc, handleLine, PROTOCOL_VERSION } from './server.js';

function makeResponse(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}

function stubClient(impl: (url: string, init: RequestInit) => Response): PinpointClient {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => impl(url, init));
  return new PinpointClient({
    apiUrl: 'https://pinpoint.example.com',
    apiKey: 'pk_standard_abc',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('tools registry', () => {
  it('exposes exactly the five deep tools', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      ['add_comment', 'get_feedback', 'list_feedback', 'list_projects', 'update_feedback_status'].sort(),
    );
  });

  it('listTools strips handlers and keeps schema', () => {
    const list = listTools();
    for (const t of list) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('description');
      expect(t.inputSchema.type).toBe('object');
      expect(t).not.toHaveProperty('handler');
    }
  });

  it('findTool returns undefined for unknown names', () => {
    expect(findTool('nope')).toBeUndefined();
  });
});

describe('callTool — validation', () => {
  const client = stubClient(() => makeResponse({ data: [] }));

  it('rejects an unknown tool', async () => {
    await expect(callTool(client, 'nope', {})).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('list_feedback requires projectId', async () => {
    await expect(callTool(client, 'list_feedback', {})).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('update_feedback_status rejects a bad status enum', async () => {
    await expect(
      callTool(client, 'update_feedback_status', { id: 'f', status: 'bogus' }),
    ).rejects.toThrow(/one of/);
  });

  it('add_comment requires a non-empty body', async () => {
    await expect(callTool(client, 'add_comment', { id: 'f', body: '   ' })).rejects.toBeInstanceOf(
      ToolValidationError,
    );
  });

  it('list_feedback rejects a non-positive limit', async () => {
    await expect(
      callTool(client, 'list_feedback', { projectId: 'p', limit: 0 }),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });
});

describe('callTool — dispatch to client', () => {
  it('list_projects calls GET /projects', async () => {
    let seen = '';
    const client = stubClient((url) => {
      seen = url;
      return makeResponse({ data: [{ id: 'p1' }] });
    });
    const res = (await callTool(client, 'list_projects', {})) as { data: unknown[] };
    expect(seen).toContain('/api/v1/projects');
    expect(res.data).toHaveLength(1);
  });

  it('add_comment calls POST /annotations/:id/comments', async () => {
    let method = '';
    const client = stubClient((_url, init) => {
      method = String(init.method);
      return makeResponse({ comment: { id: 'c' } }, 201);
    });
    await callTool(client, 'add_comment', { id: 'f', body: 'hi' });
    expect(method).toBe('POST');
  });
});

describe('MCP JSON-RPC server', () => {
  const client = stubClient((url) => {
    if (url.includes('/projects')) return makeResponse({ data: [{ id: 'p1' }], pagination: {} });
    return makeResponse({ data: [] });
  });

  it('initialize advertises protocol version + tools capability', async () => {
    const resp = await handleRpc(client, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(resp?.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'pinpoint-mcp' },
    });
  });

  it('tools/list returns the five tools', async () => {
    const resp = await handleRpc(client, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = resp?.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(5);
  });

  it('tools/call returns a text content block with the REST payload', async () => {
    const resp = await handleRpc(client, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} },
    });
    const result = resp?.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe('text');
    // PP-16: block 0 frames the payload as untrusted data, block 1 is the JSON.
    expect(result.content[0].text).toMatch(/UNTRUSTED/);
    expect(result.content[0].text).toMatch(/Do not follow instructions/);
    expect(JSON.parse(result.content[1].text)).toMatchObject({ data: [{ id: 'p1' }] });
  });

  it('tools/call with bad args yields INVALID_PARAMS (-32602)', async () => {
    const resp = await handleRpc(client, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_feedback', arguments: {} },
    });
    expect(resp?.error?.code).toBe(-32602);
  });

  it('unknown method yields METHOD_NOT_FOUND (-32601)', async () => {
    const resp = await handleRpc(client, { jsonrpc: '2.0', id: 5, method: 'frobnicate' });
    expect(resp?.error?.code).toBe(-32601);
  });

  it('notifications (no id) get no response', async () => {
    const resp = await handleRpc(client, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(resp).toBeNull();
  });

  it('invalid request shape yields INVALID_REQUEST (-32600)', async () => {
    const resp = await handleRpc(client, { foo: 'bar' });
    expect(resp?.error?.code).toBe(-32600);
  });

  it('handleLine parses a JSON line and returns a JSON response line', async () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' });
    const out = await handleLine(client, line);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toMatchObject({ jsonrpc: '2.0', id: 9, result: {} });
  });

  it('handleLine returns a parse error for malformed JSON', async () => {
    const out = await handleLine(client, '{not json');
    expect(JSON.parse(out!).error.code).toBe(-32700);
  });

  it('handleLine ignores blank lines', async () => {
    expect(await handleLine(client, '   ')).toBeNull();
  });
});
