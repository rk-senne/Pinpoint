// Regression tests for PP-02 / PP-03 / PP-04 (docs/SECURITY_REVIEW.md).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeEventBus,
  FakeMembershipRepo,
  FakePageRepo,
  FakeProjectRepo,
  FakeTeamMemberRepo,
  FakeTeamRepo,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { InviteMember } from '../usecases/inviteMember.js';
import { RemoveMember } from '../usecases/removeMember.js';
import { UpdateMemberRole } from '../usecases/updateMemberRole.js';
import { CreateProject } from '../../project/usecases/createProject.js';

async function world() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const teamMemberRepo = new FakeTeamMemberRepo({ clock, userRepo });
  const teamRepo = new FakeTeamRepo({ clock, teamMemberRepo });
  const membershipRepo = new FakeMembershipRepo();
  const eventBus = new FakeEventBus();
  const mk = (email: string) => userRepo.insert({ email, name: email, passwordHash: 'h', verified: true });
  const ownerA = await mk('a@a.test');
  const mateA = await mk('mate@a.test');
  const ownerB = await mk('b@b.test');
  const now = new Date().toISOString();
  for (const [u, org] of [[ownerA, 'orgA'], [mateA, 'orgA'], [ownerB, 'orgB']] as const) {
    membershipRepo.seed({ orgId: org, userId: u.id, role: 'member', createdAt: now } as never);
  }
  const teamA = await teamRepo.insert({ name: 'A', ownerId: ownerA.id, orgId: 'orgA' });
  await teamMemberRepo.add({ teamId: teamA.id, userId: ownerA.id, role: 'owner' });
  const teamB = await teamRepo.insert({ name: 'B', ownerId: ownerB.id, orgId: 'orgB' });
  await teamMemberRepo.add({ teamId: teamB.id, userId: ownerB.id, role: 'owner' });
  return { clock, userRepo, teamMemberRepo, teamRepo, membershipRepo, eventBus, ownerA, mateA, ownerB, teamA, teamB };
}

describe('PP-04 team invites are org-scoped', () => {
  it('rejects a registered user of another org with the same error as an unknown e-mail', async () => {
    const w = await world();
    const sut = new InviteMember({ ...w, membershipRepo: w.membershipRepo });
    const foreign = await sut.execute({ actorUserId: w.ownerA.id, teamId: w.teamA.id, email: 'b@b.test', orgId: 'orgA' });
    const unknown = await sut.execute({ actorUserId: w.ownerA.id, teamId: w.teamA.id, email: 'nobody@x.test', orgId: 'orgA' });
    expect(foreign.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (foreign.ok || unknown.ok) return;
    expect(foreign.error.constructor).toBe(unknown.error.constructor);
    expect(foreign.error.message).toBe(unknown.error.message);
    expect(await w.teamMemberRepo.findByTeamAndUser(w.teamA.id, w.ownerB.id)).toBeNull();
    expect(w.eventBus.events).toHaveLength(0);
  });

  it('accepts a same-org user and routes the event to that user only', async () => {
    const w = await world();
    const sut = new InviteMember({ ...w, membershipRepo: w.membershipRepo });
    const r = await sut.execute({ actorUserId: w.ownerA.id, teamId: w.teamA.id, email: 'mate@a.test', orgId: 'orgA' });
    expect(r.ok).toBe(true);
    expect(w.eventBus.events[0]!.room).toBe(`user:${w.mateA.id}`);
  });

  it('treats a team of another org as not found', async () => {
    const w = await world();
    const sut = new InviteMember({ ...w, membershipRepo: w.membershipRepo });
    const r = await sut.execute({ actorUserId: w.ownerB.id, teamId: w.teamB.id, email: 'mate@a.test', orgId: 'orgA' });
    expect(r.ok).toBe(false);
  });
});

describe('PP-03 createProject validates teamId', () => {
  function sut(w: Awaited<ReturnType<typeof world>>) {
    return new CreateProject({
      projectRepo: new FakeProjectRepo({ clock: w.clock }),
      pageRepo: new FakePageRepo(w.clock),
      runInTransaction: async (fn) => fn({}),
      teamRepo: w.teamRepo,
      teamMemberRepo: w.teamMemberRepo,
    });
  }
  const base = { name: 'P', urls: ['https://example.com'] };

  it('404s for a team owned by another org', async () => {
    const w = await world();
    const r = await sut(w).execute({ ...base, ownerUserId: w.ownerA.id, orgId: 'orgA', teamId: w.teamB.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.constructor.name).toBe('NotFound');
  });

  it('404s for a same-org team the caller does not manage', async () => {
    const w = await world();
    const r = await sut(w).execute({ ...base, ownerUserId: w.mateA.id, orgId: 'orgA', teamId: w.teamA.id });
    expect(r.ok).toBe(false);
  });

  it('allows a managed team in the same org', async () => {
    const w = await world();
    const r = await sut(w).execute({ ...base, ownerUserId: w.ownerA.id, orgId: 'orgA', teamId: w.teamA.id });
    expect(r.ok).toBe(true);
  });
});

describe('PP-02 realtime access is cut on removal / demotion', () => {
  it('removeMember emits session.revoked into the user room', async () => {
    const w = await world();
    await w.teamMemberRepo.add({ teamId: w.teamA.id, userId: w.mateA.id, role: 'viewer' });
    await new RemoveMember({ ...w }).execute({ actorUserId: w.ownerA.id, teamId: w.teamA.id, targetUserId: w.mateA.id });
    expect(w.eventBus.events).toContainEqual(expect.objectContaining({ type: 'session.revoked', room: `user:${w.mateA.id}` }));
  });

  it('demotion emits session.revoked, promotion does not', async () => {
    const w = await world();
    await w.teamMemberRepo.add({ teamId: w.teamA.id, userId: w.mateA.id, role: 'admin' });
    const sut = new UpdateMemberRole({ ...w });
    await sut.execute({ actorUserId: w.ownerA.id, teamId: w.teamA.id, targetUserId: w.mateA.id, role: 'viewer' });
    expect(w.eventBus.events.map((e) => e.type)).toEqual(['session.revoked']);
  });
});
