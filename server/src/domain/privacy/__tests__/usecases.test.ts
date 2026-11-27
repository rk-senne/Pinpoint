import { describe, expect, it, vi } from 'vitest';

import { EraseAccount } from '../usecases/eraseAccount.js';
import { EraseOrg } from '../usecases/eraseOrg.js';
import type { PrivacyRepo, UserMembershipSummary } from '../ports/PrivacyRepo.js';

const hasher = { hash: async (p: string) => `h:${p}`, verify: async (p: string, h: string) => h === `h:${p}` };

function mem(over: Partial<UserMembershipSummary> = {}): UserMembershipSummary {
  return { orgId: 'o1', orgName: 'Acme', role: 'owner', memberCount: 1, ownerCount: 1, hasActiveSubscription: false, ...over };
}

function fakeRepo(over: Partial<PrivacyRepo> = {}): PrivacyRepo & { eraseAccount: ReturnType<typeof vi.fn>; eraseOrg: ReturnType<typeof vi.fn> } {
  return {
    getUserAuth: vi.fn(async () => ({ email: 'a@b.test', passwordHash: 'h:pw' })),
    getUserMemberships: vi.fn(async () => [mem()]),
    getOrg: vi.fn(async () => ({ id: 'o1', name: 'Acme', hasActiveSubscription: false })),
    streamUserExport: vi.fn(),
    streamOrgExport: vi.fn(),
    eraseAccount: vi.fn(async () => ({ orgsDeleted: ['o1'], orgsLeft: [], screenshotKeys: ['k1', 'k2'] })),
    eraseOrg: vi.fn(async () => ({ screenshotKeys: ['k1'] })),
    ...over,
  } as never;
}

const eraser = () => ({ deleteScreenshots: vi.fn(async (k: readonly string[]) => ({ deleted: k.length, failed: [] as string[] })) });

describe('EraseAccount', () => {
  it('re-authenticates, erases, then deletes the screenshots of deleted orgs', async () => {
    const repo = fakeRepo();
    const e = eraser();
    const r = await new EraseAccount({ repo, passwordHasher: hasher, screenshotEraser: e }).execute({ userId: 'u', password: 'pw' });
    expect(r).toEqual({ ok: true, value: { orgsDeleted: 1, orgsLeft: 0, screenshotsDeleted: 2, screenshotsFailed: 0 } });
    expect(e.deleteScreenshots).toHaveBeenCalledWith(['k1', 'k2']);
  });

  it('never touches data on a wrong or missing password', async () => {
    const repo = fakeRepo();
    const uc = new EraseAccount({ repo, passwordHasher: hasher, screenshotEraser: eraser() });
    for (const password of ['wrong', undefined]) {
      const r = await uc.execute({ userId: 'u', password });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_PASSWORD');
    }
    expect(repo.eraseAccount).not.toHaveBeenCalled();
  });

  it('password-less (OAuth) accounts confirm with their e-mail, case-insensitively', async () => {
    const repo = fakeRepo({ getUserAuth: vi.fn(async () => ({ email: 'Oauth@Ex.test', passwordHash: null })) });
    const uc = new EraseAccount({ repo, passwordHasher: hasher, screenshotEraser: eraser() });
    const bad = await uc.execute({ userId: 'u', confirmEmail: 'other@ex.test' });
    expect(!bad.ok && bad.error.code).toBe('CONFIRMATION_MISMATCH');
    expect((await uc.execute({ userId: 'u', confirmEmail: ' oauth@ex.test ' })).ok).toBe(true);
  });

  it('blocks a sole owner of an org with other members, and active paid subscriptions', async () => {
    const e = eraser();
    const sole = fakeRepo({ getUserMemberships: vi.fn(async () => [mem({ memberCount: 3, ownerCount: 1 })]) });
    const r1 = await new EraseAccount({ repo: sole, passwordHasher: hasher, screenshotEraser: e }).execute({ userId: 'u', password: 'pw' });
    expect(!r1.ok && r1.error.code).toBe('SOLE_OWNER');
    const paid = fakeRepo({ getUserMemberships: vi.fn(async () => [mem({ hasActiveSubscription: true })]) });
    const r2 = await new EraseAccount({ repo: paid, passwordHasher: hasher, screenshotEraser: e }).execute({ userId: 'u', password: 'pw' });
    expect(!r2.ok && r2.error.code).toBe('ACTIVE_SUBSCRIPTION');
    expect(sole.eraseAccount).not.toHaveBeenCalled();
    expect(paid.eraseAccount).not.toHaveBeenCalled();
    expect(e.deleteScreenshots).not.toHaveBeenCalled();
  });

  it('allows co-owners to leave, and maps a transactional re-check block to SOLE_OWNER', async () => {
    const co = fakeRepo({ getUserMemberships: vi.fn(async () => [mem({ memberCount: 3, ownerCount: 2 })]) });
    expect((await new EraseAccount({ repo: co, passwordHasher: hasher, screenshotEraser: eraser() }).execute({ userId: 'u', password: 'pw' })).ok).toBe(true);
    const raced = fakeRepo({ eraseAccount: vi.fn(async () => ({ blockedOrgs: ['o1'] })) });
    const r = await new EraseAccount({ repo: raced, passwordHasher: hasher, screenshotEraser: eraser() }).execute({ userId: 'u', password: 'pw' });
    expect(!r.ok && r.error.code).toBe('SOLE_OWNER');
  });

  it('reports screenshots that could not be deleted', async () => {
    const e = { deleteScreenshots: vi.fn(async () => ({ deleted: 1, failed: ['k2'] })) };
    const r = await new EraseAccount({ repo: fakeRepo(), passwordHasher: hasher, screenshotEraser: e }).execute({ userId: 'u', password: 'pw' });
    expect(r.ok && r.value.screenshotsFailed).toBe(1);
  });

  it('404s for an unknown account', async () => {
    const repo = fakeRepo({ getUserAuth: vi.fn(async () => null) });
    const r = await new EraseAccount({ repo, passwordHasher: hasher, screenshotEraser: eraser() }).execute({ userId: 'u', password: 'pw' });
    expect(!r.ok && r.error.kind).toBe('NotFound');
  });
});

describe('EraseOrg', () => {
  const input = { orgId: 'o1', actorId: 'u', actorRole: 'owner', password: 'pw', confirmName: 'Acme' };

  it('requires owner, password, exact name and no active subscription', async () => {
    const repo = fakeRepo();
    const uc = new EraseOrg({ repo, passwordHasher: hasher, screenshotEraser: eraser() });
    expect((await uc.execute({ ...input, actorRole: 'admin' })).ok).toBe(false);
    const pw = await uc.execute({ ...input, password: 'x' });
    expect(!pw.ok && pw.error.code).toBe('INVALID_PASSWORD');
    const nm = await uc.execute({ ...input, confirmName: 'acme' });
    expect(!nm.ok && nm.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(repo.eraseOrg).not.toHaveBeenCalled();
    const paid = fakeRepo({ getOrg: vi.fn(async () => ({ id: 'o1', name: 'Acme', hasActiveSubscription: true })) });
    const r = await new EraseOrg({ repo: paid, passwordHasher: hasher, screenshotEraser: eraser() }).execute(input);
    expect(!r.ok && r.error.code).toBe('ACTIVE_SUBSCRIPTION');
    expect(paid.eraseOrg).not.toHaveBeenCalled();
  });

  it('erases and removes the screenshot objects', async () => {
    const repo = fakeRepo();
    const e = eraser();
    const r = await new EraseOrg({ repo, passwordHasher: hasher, screenshotEraser: e }).execute(input);
    expect(r).toEqual({ ok: true, value: { screenshotsDeleted: 1, screenshotsFailed: 0 } });
    expect(repo.eraseOrg).toHaveBeenCalledWith('o1', 'u');
    expect(e.deleteScreenshots).toHaveBeenCalledWith(['k1']);
  });
});
