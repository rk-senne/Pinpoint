// Unit tests for the requestPasswordReset use case (Phase 1.5 / task 4.11.2).
//
// Per Req 1 the use case must NEVER reveal whether an email matched a
// real user — the result is always `ok({ emailDispatched: true })`. The
// observable difference is whether an `auth_tokens` row + Mailer.send
// call was produced, which is what these tests assert.

import { describe, it, expect } from 'vitest';

import {
  FakeAuthTokenRepo,
  FakeClock,
  FakeMailer,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { RequestPasswordReset } from '../usecases/requestPasswordReset.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const mailer = new FakeMailer();

  await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: 'hashed:correcthorsebatterystaple',
    verified: true,
  });

  const usecase = new RequestPasswordReset({
    userRepo,
    authTokenRepo,
    mailer,
    clock,
    buildResetLink: (raw) => `https://app.test/reset/${raw}`,
  });

  return { usecase, authTokenRepo, mailer };
}

describe('requestPasswordReset use case', () => {
  it('mints a reset_password token and sends an email when the address matches a user', async () => {
    const { usecase, authTokenRepo, mailer } = await buildSut();

    const result = await usecase.execute({ email: 'alice@example.com' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.emailDispatched).toBe(true);

    expect(authTokenRepo.tokens.size).toBe(1);
    const token = [...authTokenRepo.tokens.values()][0]!;
    expect(token.kind).toBe('reset_password');

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('alice@example.com');
  });

  it('still resolves ok but emits nothing when the email is unknown (no enumeration)', async () => {
    const { usecase, authTokenRepo, mailer } = await buildSut();

    const result = await usecase.execute({ email: 'nobody@example.com' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.emailDispatched).toBe(true);

    // No durable side effects for an unknown email.
    expect(authTokenRepo.tokens.size).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });
});
