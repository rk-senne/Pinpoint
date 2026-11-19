// Shared-link visitor read: GET /api/v1/shared/:linkId/annotations.
//
//   - password link: 401 without the grant, 200 with the cookie issued by /verify
//   - open link: 200 with no grant
//   - the grant is bound to the link, expires, and dies if the password changes
//   - missing link -> 404; response is an explicit allow-list (no ids/emails/diagnostics)

import bcrypt from 'bcrypt';
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { request } from '../supertestClient.js';
import { createSharedLinkRoutes } from '../../adapters/inbound/http/sharedLinks.routes.js';
import { createSharedLinkAccessSigner } from '../../adapters/inbound/http/sharedLinkAccess.js';
import { BcryptPasswordHasher } from '../../adapters/outbound/bcrypt/BcryptPasswordHasher.js';
import { VerifyLinkPassword } from '../../domain/sharedLink/usecases/verifyLinkPassword.js';
import { FakeAnnotationRepo } from '../fakes/FakeAnnotationRepo.js';
import { FakeClock } from '../fakes/FakeClock.js';
import { FakePageRepo } from '../fakes/FakePageRepo.js';
import { FakeSharedLinkRepo } from '../fakes/FakeSharedLinkRepo.js';

const PROJECT = 'project-1';

async function harness() {
  const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
  const nowMs = { value: clock.now().getTime() };
  const sharedLinkRepo = new FakeSharedLinkRepo(clock);
  const annotationRepo = new FakeAnnotationRepo(clock);
  const pageRepo = new FakePageRepo(clock);
  const hasher = new BcryptPasswordHasher(4);

  const page = await pageRepo.insert({ projectId: PROJECT, url: 'https://example.com/a', title: null });
  await annotationRepo.insert({
    projectId: PROJECT,
    pageId: page.id,
    type: 'note',
    severity: 'major',
    status: 'active',
    body: 'Visible body',
    authorId: 'secret-user-id',
    target: { cssSelector: 'body', xpath: '/html/body', pageX: 1, pageY: 2, tagName: 'body', textSnippet: '' },
    environment: {
      browserFamily: 'Chrome', browserVersion: '1', osFamily: 'macOS', osVersion: '1',
      deviceType: 'desktop', userAgentRaw: 'UA-SECRET',
    },
    pinNumber: 1,
    isGuest: true,
    guestName: 'Gina',
    guestEmail: 'guest-secret@example.com',
    consoleLogs: [{ level: 'error', message: 'console-secret', timestamp: 1 }] as never,
    sessionReplay: [{ type: 'click', timestamp: 1 }] as never,
  } as never);

  const openLink = await sharedLinkRepo.insert({ id: 'open-link', projectId: PROJECT, passwordHash: null });
  const pwLink = await sharedLinkRepo.insert({
    id: 'pw-link', projectId: PROJECT, passwordHash: await bcrypt.hash('hunter2', 4),
  });
  const otherPwLink = await sharedLinkRepo.insert({
    id: 'pw-link-2', projectId: PROJECT, passwordHash: await bcrypt.hash('hunter2', 4),
  });

  const { verifyRouter } = createSharedLinkRoutes({
    createSharedLink: {} as never,
    verifyLinkPassword: new VerifyLinkPassword({ sharedLinkRepo, passwordHasher: hasher, clock }),
    authMiddleware: (_q, _r, n) => n(),
    sharedLinkRepo,
    annotationRepo,
    pageRepo,
    accessSecret: 'unit-secret',
    cookieInsecure: true,
    accessSigner: createSharedLinkAccessSigner('unit-secret', () => nowMs.value),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/shared', verifyRouter);
  return { app, nowMs, sharedLinkRepo, openLink, pwLink, otherPwLink };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'] as string[] | undefined;
  expect(raw).toBeDefined();
  return raw![0]!;
}

describe('GET /api/v1/shared/:linkId/annotations', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => { h = await harness(); });

  it('open link: readable without any grant', async () => {
    const res = await request(h.app).get('/api/v1/shared/open-link/annotations');
    expect(res.status).toBe(200);
    expect(res.body.annotations).toHaveLength(1);
  });

  it('password link: 401 without a grant', async () => {
    const res = await request(h.app).get('/api/v1/shared/pw-link/annotations');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SHARED_ACCESS_REQUIRED');
    expect(JSON.stringify(res.body)).not.toContain('Visible body');
  });

  it('password link: verify issues an HttpOnly, link-path-scoped grant that unlocks the list', async () => {
    const v = await request(h.app).post('/api/v1/shared/pw-link/verify').send({ password: 'hunter2' });
    expect(v.status).toBe(200);
    const cookie = cookieOf(v);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/shared\/pw-link(;|$)/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=1800/);

    const res = await request(h.app)
      .get('/api/v1/shared/pw-link/annotations')
      .set('Cookie', cookie.split(';')[0]!);
    expect(res.status).toBe(200);
    expect(res.body.annotations).toEqual([
      {
        pinNumber: 1, type: 'note', severity: 'major', status: 'active',
        body: 'Visible body', createdAt: expect.any(String), pageUrl: 'https://example.com/a',
      },
    ]);
    // Allow-list: nothing sensitive leaks anywhere in the payload.
    const raw = JSON.stringify(res.body);
    for (const secret of ['secret-user-id', 'guest-secret', 'Gina', 'UA-SECRET', 'console-secret', 'authorId']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('a wrong password issues no grant', async () => {
    const v = await request(h.app).post('/api/v1/shared/pw-link/verify').send({ password: 'nope' });
    expect(v.status).toBe(401);
    expect(v.headers['set-cookie']).toBeUndefined();
  });

  it('a grant for one link does not unlock another link', async () => {
    const v = await request(h.app).post('/api/v1/shared/pw-link/verify').send({ password: 'hunter2' });
    const res = await request(h.app)
      .get('/api/v1/shared/pw-link-2/annotations')
      .set('Cookie', cookieOf(v).split(';')[0]!);
    expect(res.status).toBe(401);
  });

  it('the grant expires after 30 minutes', async () => {
    const v = await request(h.app).post('/api/v1/shared/pw-link/verify').send({ password: 'hunter2' });
    const c = cookieOf(v).split(';')[0]!;
    h.nowMs.value += 29 * 60_000;
    expect((await request(h.app).get('/api/v1/shared/pw-link/annotations').set('Cookie', c)).status).toBe(200);
    h.nowMs.value += 2 * 60_000;
    expect((await request(h.app).get('/api/v1/shared/pw-link/annotations').set('Cookie', c)).status).toBe(401);
  });

  it('the grant dies when the owner changes the password', async () => {
    const v = await request(h.app).post('/api/v1/shared/pw-link/verify').send({ password: 'hunter2' });
    const c = cookieOf(v).split(';')[0]!;
    await h.sharedLinkRepo.update('pw-link', { passwordHash: await bcrypt.hash('new-pass', 4) });
    expect((await request(h.app).get('/api/v1/shared/pw-link/annotations').set('Cookie', c)).status).toBe(401);
  });

  it('rejects a tampered grant', async () => {
    const v = await request(h.app).post('/api/v1/shared/pw-link/verify').send({ password: 'hunter2' });
    const c = cookieOf(v).split(';')[0]!;
    const tampered = c.slice(0, -2) + (c.endsWith('AA') ? 'BB' : 'AA');
    expect((await request(h.app).get('/api/v1/shared/pw-link/annotations').set('Cookie', tampered)).status).toBe(401);
  });

  it('missing link -> 404', async () => {
    const res = await request(h.app).get('/api/v1/shared/does-not-exist/annotations');
    expect(res.status).toBe(404);
  });

  it('is never cacheable and is marked noindex', async () => {
    const res = await request(h.app).get('/api/v1/shared/open-link/annotations');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });
});
