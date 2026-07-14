// Inbound HTTP adapter — team routes (Phase 1.5 / task 4.9.1).
//
// Mounted at `/api/v1/teams`. Handlers wrap the domain Use_Cases for
// team lifecycle, member invite, role updates, and member removal.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';

import { PaginationParamsSchema, paginationMeta, TeamRoleSchema } from '@pinpoint/shared';

import type { CreateTeam } from '../../../domain/team/usecases/createTeam.js';
import type { ListTeams } from '../../../domain/team/usecases/listTeams.js';
import type { InviteMember } from '../../../domain/team/usecases/inviteMember.js';
import type { UpdateMemberRole } from '../../../domain/team/usecases/updateMemberRole.js';
import type { RemoveMember } from '../../../domain/team/usecases/removeMember.js';
import { sendDomainError, sendZodFailure, paramString } from './errors.js';

export interface TeamsRouteDeps {
  createTeam: CreateTeam;
  listTeams: ListTeams;
  inviteMember: InviteMember;
  updateMemberRole: UpdateMemberRole;
  removeMember: RemoveMember;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

const CreateTeamBodySchema = z.object({
  name: z.string().trim().min(1, 'Team name is required.'),
});

const InviteBodySchema = z.object({
  email: z.string().trim().min(1, 'Email is required.'),
});

const UpdateRoleBodySchema = z.object({
  role: TeamRoleSchema,
});

export function createTeamsRoutes(deps: TeamsRouteDeps): Router {
  const {
    createTeam,
    listTeams,
    inviteMember,
    updateMemberRole,
    removeMember,
    authMiddleware,
    db,
  } = deps;

  const router = Router();
  router.use(authMiddleware);

  // POST /teams ----------------------------------------------------------
  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateTeamBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid team payload.', parsed.error.flatten());
      return;
    }
    const result = await createTeam.execute({
      ownerUserId: req.user!.userId,
      name: parsed.data.name,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(201).json({
      team: {
        id: result.value.team.id,
        name: result.value.team.name,
        ownerId: result.value.team.ownerId,
        createdAt: result.value.team.createdAt,
      },
    });
  });

  // GET /teams -----------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    const userId = req.user!.userId;

    const parsed = PaginationParamsSchema.safeParse(req.query);
    const { page, pageSize } = parsed.success ? parsed.data : { page: 1, pageSize: 25 };
    const offset = (page - 1) * pageSize;

    const [{ count: total }] = await db('teams')
      .join('team_members', 'teams.id', 'team_members.team_id')
      .where('team_members.user_id', userId)
      .count('* as count');

    const result = await listTeams.execute({ userId });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }

    const paged = result.value.teams.slice(offset, offset + pageSize);

    res.status(200).json({
      data: paged.map((t) => ({
        id: t.id,
        name: t.name,
        ownerId: t.ownerId,
        createdAt: t.createdAt,
        role: t.role,
        members: t.members,
      })),
      pagination: paginationMeta(Number(total), page, pageSize),
    });
  });

  // POST /teams/:id/invite ----------------------------------------------
  router.post('/:id/invite', async (req: Request, res: Response) => {
    const parsed = InviteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid invite payload.', parsed.error.flatten());
      return;
    }
    const result = await inviteMember.execute({
      actorUserId: req.user!.userId,
      teamId: paramString(req.params.id),
      email: parsed.data.email,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const m = result.value.member;
    res.status(201).json({
      member: {
        userId: m.userId,
        teamId: m.teamId,
        role: m.role,
        email: m.email,
        name: m.name,
      },
    });
  });

  // PUT /teams/:id/members/:userId --------------------------------------
  router.put('/:id/members/:userId', async (req: Request, res: Response) => {
    const parsed = UpdateRoleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid role payload.', parsed.error.flatten());
      return;
    }
    const result = await updateMemberRole.execute({
      actorUserId: req.user!.userId,
      teamId: paramString(req.params.id),
      targetUserId: paramString(req.params.userId),
      role: parsed.data.role,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      member: {
        userId: result.value.member.userId,
        teamId: result.value.member.teamId,
        role: result.value.member.role,
      },
    });
  });

  // DELETE /teams/:id/members/:userId -----------------------------------
  router.delete('/:id/members/:userId', async (req: Request, res: Response) => {
    const result = await removeMember.execute({
      actorUserId: req.user!.userId,
      teamId: paramString(req.params.id),
      targetUserId: paramString(req.params.userId),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({
      message:
        'Member removed from team. Access to all team projects has been revoked.',
    });
  });

  return router;
}
