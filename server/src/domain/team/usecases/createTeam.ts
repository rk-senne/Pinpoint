// createTeam use case (Phase 1.5 / task 4.7.5).
//
// Implements `POST /api/v1/teams`. Creates the team row and seeds the
// creator as the team Owner in a single logical operation. The two
// writes happen sequentially through their
// respective ports — the inbound adapter is responsible for wrapping
// them in a transaction when the underlying store supports it.

import type { Team } from '../Team.js';
import type { TeamRepo } from '../ports/TeamRepo.js';
import type { TeamMemberRepo } from '../ports/TeamMemberRepo.js';
import {
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface CreateTeamInput {
  ownerUserId: string;
  name: string;
}

export interface CreateTeamOutput {
  team: Team;
}

export interface CreateTeamDeps {
  teamRepo: TeamRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class CreateTeam {
  constructor(private readonly deps: CreateTeamDeps) {}

  async execute(
    input: CreateTeamInput,
  ): Promise<Result<CreateTeamOutput, DomainError>> {
    const { teamRepo, teamMemberRepo } = this.deps;

    const trimmed = input.name.trim();
    if (trimmed.length === 0) {
      return err(new Validation('Team name is required.'));
    }

    const team = await teamRepo.insert({
      name: trimmed,
      ownerId: input.ownerUserId,
    });

    await teamMemberRepo.add({
      teamId: team.id,
      userId: input.ownerUserId,
      role: 'owner',
    });

    return ok({ team });
  }
}
