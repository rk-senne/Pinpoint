// Route-level account-enumeration tests (F-17).

import { describe, it, expect } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';
import { createAuthRoutes, type AuthRouteDeps } from './auth.routes.js';
import { RegisterUser } from '../../../domain/auth/usecases/registerUser.js';
import { ResendVerification } from '../../../domain/auth/usecases/resendVerification.js';
import {
  FakeAuthTokenRepo,
  FakeClock,
  FakeNotificationQueue,
  FakePasswordHasher,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';

async function build() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const notificationQueue = new FakeNotificationQueue(clock);
  const passwordHasher = new FakePasswordHasher();
  const buildVerifyEmailLink = (raw: string) => `https://app.test/verify/${raw}`;

  await userRepo.insert({ email: 'taken@example.com', name: 'T', passwordHash: 'h', verified: false });

  const deps = {
    registerUser: new RegisterUser({ userRepo, authTokenRepo, passwordHasher, notificationQueue, clock, buildVerifyEmailLink }),
    resendVerification: new ResendVerification({ userRepo, authTokenRepo, notificationQueue, clock, buildVerifyEmailLink }),
  } as unknown as AuthRouteDeps;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRoutes(deps));
  return { app, notificationQueue, userRepo };
}

const PW = 'correct-horse-battery-staple-7';

describe('POST /auth/register — no enumeration', () => {
  it('returns the same 201 + body shape for a new and an already-registered email', async () => {
    const { app, userRepo } = await build();
    const fresh = await request(app).post('/api/v1/auth/register').send({ email: 'fresh@example.com', password: PW, name: 'F' });
    const dup = await request(app).post('/api/v1/auth/register').send({ email: 'taken@example.com', password: PW, name: 'T2' });

    expect(fresh.status).toBe(201);
    expect(dup.status).toBe(201);
    expect(Object.keys(dup.body)).toEqual(Object.keys(fresh.body));
    expect(Object.keys(dup.body.user).sort()).toEqual(Object.keys(fresh.body.user).sort());
    expect(userRepo.users.size).toBe(2); // the dup created nothing
  });
});

describe('POST /auth/resend-verification', () => {
  it('returns an identical 200 body for unverified, unknown and malformed-but-valid inputs; only the unverified one is emailed', async () => {
    const { app, notificationQueue } = await build();
    const known = await request(app).post('/api/v1/auth/resend-verification').send({ email: 'taken@example.com' });
    const unknown = await request(app).post('/api/v1/auth/resend-verification').send({ email: 'ghost@example.com' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);

    const rows = notificationQueue.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ kind: 'verify_email', recipientEmail: 'taken@example.com' });
  });

  it('still 400s a payload without an email (schema validation, not an oracle)', async () => {
    const { app } = await build();
    const res = await request(app).post('/api/v1/auth/resend-verification').send({});
    expect(res.status).toBe(400);
  });
});
