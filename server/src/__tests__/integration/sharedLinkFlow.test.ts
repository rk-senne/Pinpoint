// ============================================================
// Integration Test: Shared link password flow including lockout
// Validates: Requirements 15.4
// ============================================================
//
// Drives the hex composition (`createSharedLinkRoutes` factory +
// `VerifyLinkPassword` use case + in-memory fakes). The test exercises
// the public contract the dashboard depends on:
//
//   - Correct password ⇒ 200 with `{ access: true, projectId }`.
//   - Wrong password    ⇒ 401 + `attemptsRemaining` (decrementing).
//   - 3rd wrong         ⇒ 423 + `lockedUntil` + `Retry-After` header.
//   - Locked link       ⇒ 423 even on the correct password.
//   - Stale lock        ⇒ allows access again after the window expires.
//   - Successful verify ⇒ resets failure counter to 0.
//
// Response envelope migration note: the legacy router emitted
// `{ error: { code, message, details: { … } } }`; the hex
// `sendDomainError` helper emits a flat envelope
// `{ error: <message>, attemptsRemaining, lockedUntil, retryAfterSeconds }`.
// The HTTP status remains the canonical signal (401 vs 423); the assertions
// now read the flat fields directly.

import bcrypt from 'bcrypt';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createSharedLinkRoutes } from '../../adapters/inbound/http/sharedLinks.routes.js';
import { BcryptPasswordHasher } from '../../adapters/outbound/bcrypt/BcryptPasswordHasher.js';
import type { ProjectRepo } from '../../domain/project/ports/ProjectRepo.js';
import {
  CreateSharedLink,
} from '../../domain/sharedLink/usecases/createSharedLink.js';
import {
  LOCKOUT_MINUTES,
  VerifyLinkPassword,
} from '../../domain/sharedLink/usecases/verifyLinkPassword.js';
import type { SharedLink } from '../../domain/sharedLink/SharedLink.js';
import { FakeClock } from '../fakes/FakeClock.js';
import { FakeSharedLinkRepo } from '../fakes/FakeSharedLinkRepo.js';

interface SeedOverrides {
  id?: string;
  projectId?: string;
  password?: string;
  failedAttempts?: number;
  lockedUntil?: string | null;
}

interface Harness {
  app: express.Express;
  clock: FakeClock;
  sharedLinkRepo: FakeSharedLinkRepo;
  seed(overrides?: SeedOverrides): Promise<SharedLink>;
}

/**
 * Build a fresh hex composition per test so the in-memory fakes never
 * bleed state across cases. We use the real `BcryptPasswordHasher`
 * adapter to keep the bcrypt round-trip in the integration scope; the
 * use case under test is intentionally driver-agnostic and works with
 * any `PasswordHasher`.
 */
function buildHarness(): Harness {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const passwordHasher = new BcryptPasswordHasher(4); // small rounds keeps the test fast
  const sharedLinkRepo = new FakeSharedLinkRepo(clock);

  const verifyLinkPassword = new VerifyLinkPassword({
    sharedLinkRepo,
    passwordHasher,
    clock,
  });

  // `createSharedLinkRoutes` requires a `CreateSharedLink` use case and an
  // `authMiddleware` because the factory returns both routers. We mount
  // only `verifyRouter`, but the factory still needs the dependencies to
  // construct the share-management half. A minimal `ProjectRepo` stub is
  // fine because the `verifyRouter` path never invokes them; the only
  // method the use case touches is `findById`.
  const stubProjectRepo: ProjectRepo = {
    insert: () => Promise.reject(new Error('not used')),
    findById: () => Promise.resolve(null),
    search: () => Promise.resolve([]),
    update: () => Promise.reject(new Error('not used')),
    delete: () => Promise.reject(new Error('not used')),
    countAnnotations: () => Promise.resolve(0),
    listMembers: () => Promise.resolve([]),
  };

  const createSharedLink = new CreateSharedLink({
    projectRepo: stubProjectRepo,
    sharedLinkRepo,
    passwordHasher,
  });

  const { verifyRouter } = createSharedLinkRoutes({
    createSharedLink,
    verifyLinkPassword,
    authMiddleware: (_req, _res, next) => next(),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/shared', verifyRouter);

  const seed = async (overrides: SeedOverrides = {}): Promise<SharedLink> => {
    const passwordHash =
      overrides.password !== undefined
        ? await bcrypt.hash(overrides.password, 4)
        : null;
    const inserted = await sharedLinkRepo.insert({
      projectId: overrides.projectId ?? 'project-1',
      passwordHash,
    });
    // Apply any failed-attempts / locked-until overrides directly on the
    // in-memory row; the repo's insert API doesn't accept them.
    const patch: Partial<SharedLink> = {};
    if (overrides.failedAttempts !== undefined) {
      patch.failedAttempts = overrides.failedAttempts;
    }
    if (overrides.lockedUntil !== undefined) {
      patch.lockedUntil = overrides.lockedUntil;
    }
    if (overrides.id !== undefined) {
      patch.id = overrides.id;
    }
    if (Object.keys(patch).length > 0) {
      const row = sharedLinkRepo.links.get(inserted.id)!;
      const next = { ...row, ...patch };
      sharedLinkRepo.links.delete(inserted.id);
      sharedLinkRepo.links.set(next.id, next);
      return { ...next };
    }
    return inserted;
  };

  return { app, clock, sharedLinkRepo, seed };
}

describe('Integration: Shared link password flow with lockout', () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  it('grants access on correct password', async () => {
    const link = await h.seed({ password: 'correctpass' });

    const res = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'correctpass' });

    expect(res.status).toBe(200);
    expect(res.body.access).toBe(true);
    expect(res.body.projectId).toBe('project-1');
  });

  it('rejects incorrect password and tracks failed attempts', async () => {
    const link = await h.seed({ password: 'correctpass' });

    const res = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrongpass' });

    // Hex envelope: 401 status is the canonical InvalidPassword signal,
    // and `attemptsRemaining` is a flat top-level field rather than
    // `error.details.attemptsRemaining`.
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Incorrect password.');
    expect(res.body.attemptsRemaining).toBe(2);
  });

  it('locks access after 3 consecutive failed attempts', async () => {
    const link = await h.seed({ password: 'correctpass' });

    // Attempt 1
    const res1 = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrong1' });
    expect(res1.status).toBe(401);
    expect(res1.body.attemptsRemaining).toBe(2);

    // Attempt 2
    const res2 = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrong2' });
    expect(res2.status).toBe(401);
    expect(res2.body.attemptsRemaining).toBe(1);

    // Attempt 3 — triggers lockout. 423 is the canonical Locked signal.
    const res3 = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrong3' });
    expect(res3.status).toBe(423);
    expect(typeof res3.body.lockedUntil).toBe('string');
    expect(res3.body.retryAfterSeconds).toBe(LOCKOUT_MINUTES * 60);
    expect(res3.headers['retry-after']).toBe(String(LOCKOUT_MINUTES * 60));
  });

  it('rejects even correct password while locked', async () => {
    const lockedUntil = new Date(
      h.clock.now().getTime() + 15 * 60 * 1000,
    ).toISOString();
    const link = await h.seed({
      password: 'correctpass',
      failedAttempts: 3,
      lockedUntil,
    });

    const res = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'correctpass' });

    expect(res.status).toBe(423);
    expect(typeof res.body.lockedUntil).toBe('string');
  });

  it('allows access after lockout period expires', async () => {
    const expiredLock = new Date(h.clock.now().getTime() - 1000).toISOString();
    const link = await h.seed({
      password: 'correctpass',
      failedAttempts: 3,
      lockedUntil: expiredLock,
    });

    const res = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'correctpass' });

    expect(res.status).toBe(200);
    expect(res.body.access).toBe(true);
  });

  it('resets failed attempts on successful password entry', async () => {
    const link = await h.seed({ password: 'correctpass', failedAttempts: 2 });

    const res = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'correctpass' });

    expect(res.status).toBe(200);
    expect(res.body.access).toBe(true);

    // Verify the persisted row was updated through the repo seam.
    const updated = h.sharedLinkRepo.links.get(link.id)!;
    expect(updated.failedAttempts).toBe(0);
    expect(updated.lockedUntil).toBeNull();
  });

  it('full flow: 2 failures → success → reset → 3 failures → lockout', async () => {
    const link = await h.seed({ password: 'mypassword' });

    // 2 failures
    await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrong' });
    await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrong' });

    // Success resets counter
    const successRes = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'mypassword' });
    expect(successRes.status).toBe(200);
    expect(h.sharedLinkRepo.links.get(link.id)!.failedAttempts).toBe(0);

    // 3 more failures should lock
    await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrong' });
    await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrong' });
    const lockRes = await request(h.app)
      .post(`/api/v1/shared/${link.id}/verify`)
      .send({ password: 'wrong' });

    expect(lockRes.status).toBe(423);
    expect(typeof lockRes.body.lockedUntil).toBe('string');
  });
});
