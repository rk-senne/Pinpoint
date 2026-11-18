// Unit tests for resendVerification (F-17): real re-issue for unverified
// accounts, identical outcome for everything else.

import { describe, it, expect } from 'vitest';

import {
  FakeAuthTokenRepo,
  FakeClock,
  FakeNotificationQueue,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { ResendVerification } from '../usecases/resendVerification.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const notificationQueue = new FakeNotificationQueue(clock);

  const unverified = await userRepo.insert({ email: 'new@example.com', name: 'N', passwordHash: 'h', verified: false });
  const verified = await userRepo.insert({ email: 'old@example.com', name: 'O', passwordHash: 'h', verified: true });

  const usecase = new ResendVerification({
    userRepo,
    authTokenRepo,
    notificationQueue,
    clock,
    buildVerifyEmailLink: (raw) => `https://app.test/verify/${raw}`,
  });
  return { usecase, authTokenRepo, notificationQueue, unverified, verified };
}

describe('resendVerification use case', () => {
  it('issues a fresh verify_email token and enqueues the email for an unverified user', async () => {
    const { usecase, authTokenRepo, notificationQueue, unverified } = await buildSut();

    const res = await usecase.execute({ email: 'New@Example.com' });
    expect(res).toEqual({ ok: true, value: { requested: true } });

    const tokens = [...authTokenRepo.tokens.values()];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ userId: unverified.id, kind: 'verify_email', used: false });

    const rows = notificationQueue.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      kind: 'verify_email',
      recipientUserId: unverified.id,
      recipientEmail: 'new@example.com',
    });
    expect(String(rows[0]!.payload.link)).toMatch(/^https:\/\/app\.test\/verify\/[0-9a-f]{64}$/);
  });

  it('voids the previous token so only the newest link works', async () => {
    const { usecase, authTokenRepo } = await buildSut();
    await usecase.execute({ email: 'new@example.com' });
    await usecase.execute({ email: 'new@example.com' });
    const tokens = [...authTokenRepo.tokens.values()];
    expect(tokens).toHaveLength(2);
    expect(tokens.filter((t) => !t.used)).toHaveLength(1);
  });

  it.each(['nobody@example.com', 'old@example.com', '', 42 as unknown as string])(
    'returns the identical result and sends nothing for %j',
    async (email) => {
      const { usecase, authTokenRepo, notificationQueue } = await buildSut();
      const res = await usecase.execute({ email });
      expect(res).toEqual({ ok: true, value: { requested: true } });
      expect(authTokenRepo.tokens.size).toBe(0);
      expect(notificationQueue.list()).toHaveLength(0);
    },
  );
});
