// PP-06: confirming an e-mail change through the shared /verify-email/:token endpoint.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import { FakeAuthTokenRepo, FakeClock, FakeUserRepo } from '../../../__tests__/fakes/index.js';
import { VerifyEmail } from '../usecases/verifyEmail.js';

async function setup(pending: string | null = 'new@example.com') {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const user = await userRepo.insert({ email: 'old@example.com', name: 'U', passwordHash: 'h', verified: true });
  if (pending) await userRepo.setPendingEmail(user.id, pending);
  await authTokenRepo.insert({
    userId: user.id,
    kind: 'change_email',
    tokenHash: createHash('sha256').update('raw-token').digest('hex'),
    expiresAt: new Date(clock.now().getTime() + 3600_000).toISOString(),
  });
  return { sut: new VerifyEmail({ authTokenRepo, userRepo, clock }), userRepo, user, authTokenRepo };
}

describe('confirming an e-mail change', () => {
  it('applies pending_email, clears it and revokes every session', async () => {
    const { sut, userRepo, user } = await setup();
    const r = await sut.execute({ token: 'raw-token' });
    expect(r.ok).toBe(true);
    const after = (await userRepo.findByIdWithSecret(user.id))!;
    expect(after.email).toBe('new@example.com');
    expect(after.pendingEmail ?? null).toBeNull();
    expect(after.tokenVersion).toBe(1);
  });

  it('is single use', async () => {
    const { sut } = await setup();
    expect((await sut.execute({ token: 'raw-token' })).ok).toBe(true);
    expect((await sut.execute({ token: 'raw-token' })).ok).toBe(false);
  });

  it('refuses when the address was registered by someone else in the meantime', async () => {
    const { sut, userRepo, user } = await setup();
    await userRepo.insert({ email: 'new@example.com', name: 'X', passwordHash: 'h', verified: true });
    expect((await sut.execute({ token: 'raw-token' })).ok).toBe(false);
    expect((await userRepo.findById(user.id))!.email).toBe('old@example.com');
  });

  it('does nothing when there is no pending address', async () => {
    const { sut, userRepo, user } = await setup(null);
    expect((await sut.execute({ token: 'raw-token' })).ok).toBe(false);
    expect((await userRepo.findById(user.id))!.email).toBe('old@example.com');
  });
});
