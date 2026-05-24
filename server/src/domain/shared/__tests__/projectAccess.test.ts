// Unit tests for the shared project-access predicates.
//
// `hasProjectAccess` and `hasProjectAdminAccess` collapse what used to
// be byte-identical copies in every project / annotation use case
// (Reqs 22 / 23). The matrix below pins the four scenarios each helper
// must satisfy: owner, no team set + non-owner, team set + member,
// team set + non-member.

import { describe, it, expect, beforeEach } from 'vitest';

import { FakeClock, FakeTeamMemberRepo } from '../../../__tests__/fakes/index.js';
import {
  hasProjectAccess,
  hasProjectAdminAccess,
} from '../projectAccess.js';

const OWNER = 'user-owner';
const TEAM = 'team-1';

let teamMemberRepo: FakeTeamMemberRepo;

beforeEach(() => {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  teamMemberRepo = new FakeTeamMemberRepo({ clock });
});

describe('hasProjectAccess', () => {
  it('grants access to the project owner', async () => {
    const allowed = await hasProjectAccess(teamMemberRepo, OWNER, TEAM, OWNER);
    expect(allowed).toBe(true);
  });

  it('denies a non-owner when the project has no team', async () => {
    const allowed = await hasProjectAccess(
      teamMemberRepo,
      OWNER,
      undefined,
      'user-other',
    );
    expect(allowed).toBe(false);
  });

  it('grants access to any team member, regardless of role', async () => {
    await teamMemberRepo.add({ teamId: TEAM, userId: 'user-viewer', role: 'viewer' });
    const allowed = await hasProjectAccess(
      teamMemberRepo,
      OWNER,
      TEAM,
      'user-viewer',
    );
    expect(allowed).toBe(true);
  });

  it('denies a user who is not a member of the project team', async () => {
    await teamMemberRepo.add({ teamId: TEAM, userId: 'user-viewer', role: 'viewer' });
    const allowed = await hasProjectAccess(
      teamMemberRepo,
      OWNER,
      TEAM,
      'user-stranger',
    );
    expect(allowed).toBe(false);
  });
});

describe('hasProjectAdminAccess', () => {
  it('grants access to the project owner', async () => {
    const allowed = await hasProjectAdminAccess(
      teamMemberRepo,
      OWNER,
      TEAM,
      OWNER,
    );
    expect(allowed).toBe(true);
  });

  it('denies a non-owner when the project has no team', async () => {
    const allowed = await hasProjectAdminAccess(
      teamMemberRepo,
      OWNER,
      undefined,
      'user-other',
    );
    expect(allowed).toBe(false);
  });

  it('grants access to a team admin or team owner but denies a viewer', async () => {
    await teamMemberRepo.add({ teamId: TEAM, userId: 'user-admin', role: 'admin' });
    await teamMemberRepo.add({ teamId: TEAM, userId: 'user-team-owner', role: 'owner' });
    await teamMemberRepo.add({ teamId: TEAM, userId: 'user-viewer', role: 'viewer' });

    expect(
      await hasProjectAdminAccess(teamMemberRepo, OWNER, TEAM, 'user-admin'),
    ).toBe(true);
    expect(
      await hasProjectAdminAccess(teamMemberRepo, OWNER, TEAM, 'user-team-owner'),
    ).toBe(true);
    expect(
      await hasProjectAdminAccess(teamMemberRepo, OWNER, TEAM, 'user-viewer'),
    ).toBe(false);
  });

  it('denies a user who is not a member of the project team', async () => {
    await teamMemberRepo.add({ teamId: TEAM, userId: 'user-admin', role: 'admin' });
    const allowed = await hasProjectAdminAccess(
      teamMemberRepo,
      OWNER,
      TEAM,
      'user-stranger',
    );
    expect(allowed).toBe(false);
  });
});
