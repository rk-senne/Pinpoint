import { describe, expect, it } from 'vitest';
import express from 'express';
import { request } from '../__tests__/supertestClient.js';
import { createMetrics, isPrivateAddress } from './metrics.js';

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
