import { describe, expect, it } from 'vitest';
import express from 'express';
import { request } from '../__tests__/supertestClient.js';
import client from 'prom-client';
import { createMetrics, isPrivateAddress, startQueueMetrics, type RawQueryRunner } from './metrics.js';

function app(token?: string) {
  const m = createMetrics({ token, collectDefaults: false });
  const a = express();
  a.use(m.middleware);
  a.get('/api/v1/projects/:id', (_req, res) => res.json({ ok: true }));
  a.get('/metrics', (req, res) => void m.handler(req, res));
  return a;
}

describe('metrics', () => {
  it('records requests by matched route pattern, not raw URL', async () => {
    const a = app();
    await request(a).get('/api/v1/projects/abc');
    await request(a).get('/api/v1/projects/def');
    await request(a).get('/nope');
    const res = await request(a).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('http_requests_total{method="GET",route="/api/v1/projects/:id",status="200"} 2');
    expect(res.text).toContain('route="unmatched",status="404"');
    expect(res.text).not.toContain('/api/v1/projects/abc');
    expect(res.text).toContain('http_request_duration_seconds_bucket');
  });

  it('requires the bearer token when METRICS_TOKEN is set', async () => {
    const a = app('s3cret-token');
    expect((await request(a).get('/metrics')).status).toBe(401);
    expect((await request(a).get('/metrics').set('Authorization', 'Bearer wrong-token!')).status).toBe(401);
    expect((await request(a).get('/metrics').set('Authorization', 'Bearer s3cret-token')).status).toBe(200);
  });

  it('tokenless: loopback scrape allowed, but anything that came through a proxy is refused (PP-07)', async () => {
    const a = app();
    expect((await request(a).get('/metrics')).status).toBe(200);
    // The peer is loopback (supertest), exactly like an ALB's private address —
    // the forwarding headers are what reveal a public client behind it.
    expect((await request(a).get('/metrics').set('X-Forwarded-For', '203.0.113.9')).status).toBe(403);
    expect((await request(a).get('/metrics').set('Forwarded', 'for=203.0.113.9')).status).toBe(403);
  });

  it('tokenless: with trust proxy the decision uses the real client address (req.ip)', async () => {
    const m = createMetrics({ collectDefaults: false });
    const a = express();
    a.set('trust proxy', 1);
    a.use((req, _res, next) => {
      // simulate the proxy hop having already been unwrapped by Express
      Object.defineProperty(req, 'ip', { value: '203.0.113.9' });
      delete req.headers['x-forwarded-for'];
      next();
    });
    a.get('/metrics', (req, res) => void m.handler(req, res));
    expect((await request(a).get('/metrics')).status).toBe(403);
  });

  it('classifies private vs public callers', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:10.0.0.5', '172.20.1.1', '192.168.1.2', '100.64.0.1', 'fd00::1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2606:4700::1', undefined]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});

describe('metrics route labels for pre-route rejections', () => {
  it('labels router-level rejections by API area, never by concrete id', async () => {
    const m = createMetrics({ collectDefaults: false });
    const a = express();
    a.use(m.middleware);
    const r = express.Router({ mergeParams: true });
    r.use((_req, res) => res.status(401).json({}));
    a.use('/api/v1/projects/:id/annotations', r);
    a.get('/metrics', (req, res) => void m.handler(req, res));
    await request(a).get('/api/v1/projects/0b7c1f2e-1111-4222-8333-444455556666/annotations');
    const text = (await request(a).get('/metrics')).text;
    expect(text).toContain('route="/api/v1/projects/*",status="401"');
    expect(text).not.toContain('0b7c1f2e');
  });

  it('collapses unknown top-level areas to "unmatched" (bounded cardinality, F-21)', async () => {
    const m = createMetrics({ collectDefaults: false });
    const a = express();
    a.use(m.middleware);
    a.use('/api/v1', (_req, res) => res.status(401).json({}));
    a.get('/metrics', (req, res) => void m.handler(req, res));
    for (const junk of ['zzz-random-1', 'aaa-attacker-2', 'projectz']) {
      await request(a).get(`/api/v1/${junk}/x`);
    }
    const text = (await request(a).get('/metrics')).text;
    expect(text).toContain('route="unmatched",status="401"');
    expect(text).not.toContain('zzz-random-1');
    expect(text).not.toContain('attacker');
    expect(text).not.toContain('projectz');
  });
});

describe('startQueueMetrics', () => {
  type Row = Record<string, unknown>;
  function fakeDb(state: { up: boolean; notif: Row[]; hooks: Row[] }): RawQueryRunner {
    return {
      raw: async (sql: string) => {
        if (!state.up) throw new Error('connection refused');
        if (sql.includes('FROM notifications')) return { rows: state.notif };
        if (sql.includes('FROM webhook_deliveries')) return { rows: state.hooks };
        return { rows: [{ '?column?': 1 }] };
      },
    };
  }
  const asSystem = <T>(fn: () => T): T => fn();

  it('exports db_up, pending depth, oldest age and counts only NEW failures', async () => {
    const state = {
      up: true,
      notif: [{ status: 'pending', n: 3, oldest_age: 120 }, { status: 'failed', n: 2, oldest_age: 9 }],
      hooks: [{ status: 'pending', n: 1, oldest_age: 5 }],
    };
    const registry = new client.Registry();
    const q = startQueueMetrics(registry, { db: fakeDb(state), asSystem, intervalMs: 3_600_000 });
    await q.collect();
    let text = await registry.metrics();
    expect(text).toMatch(/^pinpoint_db_up 1$/m);
    expect(text).toMatch(/^pinpoint_notifications_pending 3$/m);
    expect(text).toMatch(/^pinpoint_notifications_oldest_pending_age_seconds 120$/m);
    expect(text).toMatch(/^pinpoint_webhook_deliveries_pending 1$/m);
    // The two pre-existing failed rows are the baseline, not new failures.
    expect(text).toMatch(/^pinpoint_notification_failures_total 0$/m);
    expect(text).toMatch(/^pinpoint_queue_metrics_last_success_timestamp_seconds [0-9.e+]+$/m);

    state.notif = [{ status: 'failed', n: 5, oldest_age: 1 }];
    state.hooks = [{ status: 'pending', n: 0, oldest_age: 0 }, { status: 'failed', n: 4, oldest_age: 1 }];
    await q.collect();
    text = await registry.metrics();
    expect(text).toMatch(/^pinpoint_notifications_pending 0$/m);
    expect(text).toMatch(/^pinpoint_notification_failures_total 3$/m);
    // webhook failed rows appeared after a 0 baseline -> 4 new failures
    expect(text).toMatch(/^pinpoint_webhook_delivery_failures_total 4$/m);
    q.stop();
  });

  it('sets pinpoint_db_up to 0 and reports the error when the database is unreachable', async () => {
    const state = { up: false, notif: [], hooks: [] };
    const registry = new client.Registry();
    const errors: unknown[] = [];
    const q = startQueueMetrics(registry, { db: fakeDb(state), asSystem, intervalMs: 3_600_000, onError: (e) => errors.push(e) });
    await q.collect();
    expect(await registry.metrics()).toMatch(/^pinpoint_db_up 0$/m);
    expect(errors.length).toBeGreaterThan(0);
    state.up = true;
    await q.collect();
    expect(await registry.metrics()).toMatch(/^pinpoint_db_up 1$/m);
    q.stop();
  });
});
