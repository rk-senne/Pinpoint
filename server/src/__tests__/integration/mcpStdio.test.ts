// End-to-end MCP test: spawns the BUILT mcp-server/dist/index.js over stdio
// against the real composition root listening on an ephemeral port (real PG),
// authenticated with a freshly minted org API key. Covers initialize,
// tools/list and every tool, plus key-scope and misconfiguration behaviour.
// Skips when no migrated test DB or no built mcp-server/dist.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { bootLiveApp, type LiveActor, type LiveApp } from './helpers/liveApp.js';

// server compiles to CommonJS (no import.meta); this file lives at server/src/__tests__/integration.
const MCP_ENTRY = path.resolve(__dirname, '../../../../mcp-server/dist/index.js');

let live: LiveApp | null = null;
let skip: string | null = null;
let httpServer: Server | null = null;
let apiUrl = '';
let rawKey = '';
let admin: LiveActor;
let projectId = '';
let annotationId = '';

interface Rpc { jsonrpc: '2.0'; id?: number | string | null; result?: any; error?: { code: number; message: string } }

/** Minimal stdio JSON-RPC client over the spawned MCP server. */
class McpProc {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private waiters = new Map<number, (r: Rpc) => void>();
  private nextId = 1;
  stderr = '';
  exited: Promise<number | null>;

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [MCP_ENTRY], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'pipe' });
    this.child.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as Rpc;
        if (typeof msg.id === 'number') this.waiters.get(msg.id)?.(msg);
      }
    });
    this.child.stderr.on('data', (d: Buffer) => { this.stderr += d.toString(); });
    this.exited = new Promise((r) => this.child.on('exit', (code) => r(code)));
  }

  call(method: string, params?: unknown): Promise<Rpc> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`MCP ${method} timed out; stderr=${this.stderr}`)), 15_000);
      this.waiters.set(id, (r) => { clearTimeout(t); resolve(r); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method: string) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
  tool(name: string, args: Record<string, unknown>) { return this.call('tools/call', { name, arguments: args }); }
  close() { this.child.stdin.end(); return this.exited; }
  kill() { this.child.kill('SIGKILL'); }
}

// Block 0 is the untrusted-content notice (prompt-injection mitigation); block 1 is the data.
const payload = (r: Rpc) => {
  expect(r.result.content[0].text).toMatch(/UNTRUSTED/);
  return JSON.parse(r.result.content[1].text);
};

describe('Integration: MCP server over stdio against the live API', () => {
  let mcp: McpProc | null = null;

  beforeAll(async () => {
    if (!existsSync(MCP_ENTRY)) { skip = 'mcp-server/dist not built (npm run build --workspace @pinpoint/mcp-server)'; return; }
    const booted = await bootLiveApp();
    if ('skip' in booted) { skip = booted.skip; return; }
    live = booted;
    const seeded = await live.seedOrg(['admin']);
    admin = seeded.actors.admin!;
    projectId = await live.seedProject(seeded.orgId, admin.id);
    httpServer = await new Promise<Server>((resolve) => { const s = live!.app.listen(0, '127.0.0.1', () => resolve(s)); });
    apiUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const key = await request(live.app).post('/api/v1/api-keys').set('Authorization', `Bearer ${await admin.token()}`).send({ name: 'mcp-it' });
    expect(key.status).toBe(201);
    rawKey = key.body.rawKey;
    const ann = await request(live.app).post(`/api/v1/projects/${projectId}/annotations`).set('Authorization', `Bearer ${await admin.token()}`).send({
      type: 'note', body: 'mcp subject', pageUrl: 'https://mcp.test/', severity: 'major',
      target: { cssSelector: 'div', xpath: '/div', pageX: 1, pageY: 2, tagName: 'DIV', textSnippet: '' },
      environment: { browserFamily: 'Chrome', browserVersion: '126', osFamily: 'macOS', osVersion: '14', deviceType: 'desktop', userAgentRaw: 'ua' },
    });
    expect([200, 201]).toContain(ann.status);
    annotationId = (ann.body.annotation ?? ann.body).id;
    mcp = new McpProc({ PINPOINT_API_URL: apiUrl, PINPOINT_API_KEY: rawKey });
  });

  afterAll(async () => {
    if (mcp) { mcp.kill(); await mcp.exited; }
    await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r()));
    await live?.cleanup();
  });

  it('initialize advertises protocol + tools capability; notifications get no reply', async ({ skip: s }) => {
    if (skip) return s(skip);
    const init = await mcp!.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'it', version: '0' } });
    expect(init.error).toBeUndefined();
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.serverInfo.name).toBeTruthy();
    mcp!.notify('notifications/initialized');
    // Still responsive after a notification (no stray reply consumed an id).
    expect((await mcp!.call('ping')).error?.code ?? 0).toBeLessThanOrEqual(0);
  });

  it('tools/list returns exactly the five tools with input schemas', async ({ skip: s }) => {
    if (skip) return s(skip);
    const res = await mcp!.call('tools/list');
    const names = res.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['add_comment', 'get_feedback', 'list_feedback', 'list_projects', 'update_feedback_status']);
    for (const t of res.result.tools) expect(t.inputSchema.type).toBe('object');
  });

  it('list_projects / list_feedback / get_feedback return real data scoped to the key org', async ({ skip: s }) => {
    if (skip) return s(skip);
    const projects = payload(await mcp!.tool('list_projects', {}));
    expect(JSON.stringify(projects)).toContain(projectId);
    const feedback = payload(await mcp!.tool('list_feedback', { projectId }));
    expect(feedback.data.map((a: { id: string }) => a.id)).toContain(annotationId);
    const major = payload(await mcp!.tool('list_feedback', { projectId, severity: 'major' }));
    expect(major.data).toHaveLength(1);
    const minor = payload(await mcp!.tool('list_feedback', { projectId, severity: 'minor' }));
    expect(minor.data).toHaveLength(0);
    const one = payload(await mcp!.tool('get_feedback', { id: annotationId, projectId }));
    expect(one.feedback.id).toBe(annotationId);
    expect(one.comments).toEqual([]);
    expect(one.diagnostics).toHaveProperty('environment');
  });

  it('add_comment + update_feedback_status mutate through the API (feedback:write scope)', async ({ skip: s }) => {
    if (skip) return s(skip);
    const c = await mcp!.tool('add_comment', { id: annotationId, body: 'hello from mcp' });
    expect(c.error).toBeUndefined();
    const row = await live!.db('comments').where({ annotation_id: annotationId }).first();
    expect(row.body).toBe('hello from mcp');
    const u = await mcp!.tool('update_feedback_status', { id: annotationId, status: 'resolved' });
    expect(u.error).toBeUndefined();
    expect((await live!.db('annotations').where({ id: annotationId }).first('status')).status).toBe('resolved');
    const after = payload(await mcp!.tool('get_feedback', { id: annotationId, projectId }));
    expect(after.comments).toHaveLength(1);
  });

  it('bad arguments and unknown ids surface as JSON-RPC / tool errors, not a crash', async ({ skip: s }) => {
    if (skip) return s(skip);
    expect((await mcp!.tool('list_feedback', {})).error?.code).toBe(-32602);
    expect((await mcp!.tool('update_feedback_status', { id: annotationId, status: 'bogus' })).error?.code).toBe(-32602);
    expect((await mcp!.tool('nope', {})).error).toBeDefined();
    expect((await mcp!.call('does/not/exist')).error?.code).toBe(-32601);
    const missing = await mcp!.tool('get_feedback', { id: '00000000-0000-4000-8000-000000000000', projectId });
    expect(missing.error ?? missing.result?.isError).toBeTruthy();
    // Process is still alive and answering.
    expect((await mcp!.call('tools/list')).result.tools).toHaveLength(5);
  });

  it('a read-only key can read but its writes are refused by the API', async ({ skip: s }) => {
    if (skip) return s(skip);
    const ro = await request(live!.app).post('/api/v1/api-keys').set('Authorization', `Bearer ${await admin.token()}`).send({ name: 'ro', scopes: ['feedback:read'] });
    expect(ro.status).toBe(201);
    const p = new McpProc({ PINPOINT_API_URL: apiUrl, PINPOINT_API_KEY: ro.body.rawKey });
    try {
      await p.call('initialize', {});
      expect(payload(await p.tool('list_feedback', { projectId })).data.length).toBeGreaterThan(0);
      const w = await p.tool('add_comment', { id: annotationId, body: 'should fail' });
      expect(JSON.stringify(w)).toMatch(/INSUFFICIENT_SCOPE|403/);
      expect(await live!.db('comments').where({ annotation_id: annotationId, body: 'should fail' }).first()).toBeUndefined();
    } finally { p.kill(); await p.exited; }
  });

  it('refuses to start without config, and rejects widget keys, with a clear stderr and exit code 1', async ({ skip: s }) => {
    if (skip) return s(skip);
    const none = new McpProc({});
    expect(await none.exited).toBe(1);
    expect(none.stderr).toMatch(/configuration error/i);
    const widget = new McpProc({ PINPOINT_API_URL: apiUrl, PINPOINT_API_KEY: 'pk_widget_abcdef0123456789' });
    expect(await widget.exited).toBe(1);
    expect(widget.stderr).toMatch(/widget/i);
  });

  it('exits 0 cleanly when stdin closes', async ({ skip: s }) => {
    if (skip) return s(skip);
    const p = new McpProc({ PINPOINT_API_URL: apiUrl, PINPOINT_API_KEY: rawKey });
    await p.call('initialize', {});
    expect(await p.close()).toBe(0);
  });
});
