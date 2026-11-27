// End-to-end webhook delivery against a real HTTP receiver.
//
// annotation created through the API -> WebhookDispatchingEventBus enqueues a
// durable delivery row (real Postgres) -> DispatchWebhookDeliveries claims it
// and POSTs through the real SSRF egress guard -> local receiver. The only
// test seam is the guard's test-only resolver (`allowPrivateForTests`, honoured
// only under NODE_ENV=test), which maps a public-looking hostname to the
// loopback receiver; IP-literal URLs stay blocked.
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from '../supertestClient.js';
import { bootLiveApp, type LiveActor, type LiveApp } from './helpers/liveApp.js';
import { PgWebhookRepo } from '../../adapters/outbound/postgres/PgWebhookRepo.js';
import { SecretBox } from '../../services/secretBox.js';
import { DispatchWebhookDeliveries } from '../../domain/webhook/usecases/webhooks.js';
import { generateSecret, verifySignature } from '../../services/standardWebhooks.js';
import { safeFetch } from '../../services/egressGuard.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const HOOK_HOST = 'hooks.pinpoint-e2e.test';

interface Received { headers: IncomingHttpHeaders; body: string }

let live: LiveApp | undefined;
let skip: string | undefined;
let admin: LiveActor;
let projectId: string;
let server: Server;
let port = 0;
const received: Received[] = [];
let respondWith = 200;

const target = { cssSelector: 'h1', xpath: '/html/body/h1', pageX: 10, pageY: 10, tagName: 'H1', textSnippet: 'Hi' };
const environment = {
  browserFamily: 'Chrome', browserVersion: '1', osFamily: 'macOS', osVersion: '1',
  deviceType: 'desktop', userAgentRaw: 'ua',
};

beforeAll(async () => {
  const booted = await bootLiveApp({ INTEGRATION_ENCRYPTION_KEY: KEY });
  if ('skip' in booted) { skip = booted.skip; return; }
  live = booted;
  const { orgId, actors } = await live.seedOrg(['admin']);
  admin = actors.admin!;
  projectId = await live.seedProject(orgId, admin.id);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = respondWith;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  await live?.cleanup();
});

function deliverer(repo: PgWebhookRepo): DispatchWebhookDeliveries {
  return new DispatchWebhookDeliveries({
    webhookRepo: repo,
    safeFetch: (url, init) =>
      safeFetch(url, init as never, {
        allowHttp: true,
        allowPrivateForTests: true,
        lookup: async (host) => (host === HOOK_HOST ? [{ address: '127.0.0.1', family: 4 }] : []),
      }) as never,
  });
}

async function waitForDelivery(endpointId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const row = await live!.db('webhook_deliveries').where({ endpoint_id: endpointId }).first('id');
    if (row) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no delivery row was enqueued');
}

describe('Integration: webhook delivery end to end', () => {
  it('delivers a signed annotation.created event that verifies with the endpoint secret', async ({ skip: s }) => {
    if (skip) return s(skip);
    received.length = 0;
    respondWith = 200;
    const repo = new PgWebhookRepo(live!.db, SecretBox.fromRawKey(KEY));
    const secret = generateSecret();
    const endpoint = await repo.insert({
      orgId: admin.orgId, url: `http://${HOOK_HOST}:${port}/hook`, secret, events: ['annotation.created'],
    });

    const created = await request(live!.app)
      .post(`/api/v1/projects/${projectId}/annotations`)
      .set('Authorization', `Bearer ${await admin.token()}`)
      .send({ type: 'note', body: 'webhook e2e', pageUrl: 'https://pg.test/', severity: 'major', target, environment });
    expect([200, 201]).toContain(created.status);
    const annotationId = created.body.annotation.id as string;

    await waitForDelivery(endpoint.id);
    const { dispatched } = await deliverer(repo).execute({ batchSize: 10 });
    expect(dispatched.some((d) => d.outcome === 'sent')).toBe(true);

    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers['x-pinpoint-event']).toBe('annotation.created');
    const msgId = String(headers['webhook-id']);
    const ts = Number(headers['webhook-timestamp']);
    const sig = String(headers['webhook-signature']);
    expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(60);

    // Library verification...
    expect(verifySignature(secret, msgId, ts, body, sig)).toBe(true);
    // ...and an independent Standard Webhooks computation (v1, HMAC-SHA256
    // over "id.timestamp.body" keyed with the base64 part of whsec_).
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key).update(`${msgId}.${ts}.${body}`).digest('base64');
    expect(sig.split(' ')).toContain(`v1,${expected}`);
    // A tampered body must not verify.
    expect(verifySignature(secret, msgId, ts, body.replace('webhook e2e', 'tampered'), sig)).toBe(false);

    const payload = JSON.parse(body) as { event: string; data: { id?: string; annotation?: { id: string } } };
    expect(payload.event).toBe('annotation.created');
    expect(payload.data.id ?? payload.data.annotation?.id).toBe(annotationId);

    const row = await live!.db('webhook_deliveries').where({ endpoint_id: endpoint.id }).first('status', 'attempts');
    expect(row).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('schedules a retry when the receiver answers 500, and never delivers to other orgs', async ({ skip: s }) => {
    if (skip) return s(skip);
    received.length = 0;
    respondWith = 500;
    const repo = new PgWebhookRepo(live!.db, SecretBox.fromRawKey(KEY));
    const mine = await repo.insert({
      orgId: admin.orgId, url: `http://${HOOK_HOST}:${port}/retry`, secret: generateSecret(), events: ['annotation.created'],
    });
    const other = await live!.seedOrg(['owner']);
    const foreign = await repo.insert({
      orgId: other.orgId, url: `http://${HOOK_HOST}:${port}/foreign`, secret: generateSecret(), events: ['annotation.created'],
    });

    const created = await request(live!.app)
      .post(`/api/v1/projects/${projectId}/annotations`)
      .set('Authorization', `Bearer ${await admin.token()}`)
      .send({ type: 'note', body: 'retry me', pageUrl: 'https://pg.test/', severity: 'minor', target, environment });
    expect([200, 201]).toContain(created.status);

    await waitForDelivery(mine.id);
    await deliverer(repo).execute({ batchSize: 10 });
    const row = await live!.db('webhook_deliveries').where({ endpoint_id: mine.id }).first('status', 'attempts', 'scheduled_at');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(new Date(row.scheduled_at).getTime()).toBeGreaterThan(Date.now());
    expect(await live!.db('webhook_deliveries').where({ endpoint_id: foreign.id }).first()).toBeUndefined();
    expect(received.every((r) => r.headers['x-pinpoint-event'] === 'annotation.created')).toBe(true);
  });
});
