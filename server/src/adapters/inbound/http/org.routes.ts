import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import type { InviteToOrg } from '../../../domain/org/usecases/inviteToOrg.js';
import type { AcceptInvitation } from '../../../domain/org/usecases/acceptInvitation.js';
import type { MembershipRepo } from '../../../domain/auth/ports/MembershipRepo.js';
import type { OrgRepo } from '../../../domain/org/ports/OrgRepo.js';
import type { UserRepo } from '../../../domain/user/ports/UserRepo.js';
import type { TokenIssuer } from '../../../domain/auth/ports/TokenIssuer.js';
import { sendDomainError, sendZodFailure, validateUuidParam } from './errors.js';
import { recordAudit } from './auditLog.routes.js';

// --- Zod schemas for org route inputs ---

const UpdateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens').min(2).max(50).optional(),
}).refine(data => data.name !== undefined || data.slug !== undefined, {
  message: 'At least one of name or slug must be provided',
});

const UpdateMemberRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

const SwitchOrgSchema = z.object({
  orgId: z.string().uuid(),
});

const CreateInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

export interface OrgRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  inviteToOrg: InviteToOrg;
  acceptInvitation: AcceptInvitation;
  membershipRepo: MembershipRepo;
  orgRepo: OrgRepo;
  userRepo: UserRepo;
  tokenIssuer: TokenIssuer;
  db: Knex;
}

export function createOrgRoutes(deps: OrgRouteDeps): Router {
  const router = Router();
  const { authMiddleware, inviteToOrg, acceptInvitation, membershipRepo, orgRepo, userRepo, tokenIssuer, db } = deps;

  // GET /api/v1/org — current org settings
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    const org = await orgRepo.findById(req.user!.orgId);
    if (!org) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found.' } });
    res.json({ org });
  });

  // PATCH /api/v1/org — update org settings (owner/admin only)
  router.patch('/', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }
    const parsed = UpdateOrgSchema.safeParse(req.body);
    if (!parsed.success) return sendZodFailure(res, 'Invalid org update.', parsed.error.flatten());
    const { name, slug } = parsed.data;
    const org = await orgRepo.update(req.user!.orgId, { name, slug });
    await recordAudit(db, {
      orgId: req.user!.orgId,
      actorId: req.user!.userId,
      action: 'org.settings_updated',
      resourceType: 'org',
      resourceId: req.user!.orgId,
      metadata: { name, slug },
    });
    res.json({ org });
  });

  // GET /api/v1/org/members — list org members
  router.get('/members', authMiddleware, async (req: Request, res: Response) => {
    const members = await membershipRepo.listByOrgWithUsers(req.user!.orgId);
    res.json({ members });
  });

  // DELETE /api/v1/org/members/:userId — remove member (owner/admin only)
  router.delete('/members/:userId', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }
    const userId = req.params.userId as string;
    if (!validateUuidParam(res, 'userId', userId)) return;
    if (userId === req.user!.userId) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Cannot remove yourself.' } });
    }
    await membershipRepo.removeByOrgAndUser(req.user!.orgId, userId);
    res.status(204).end();
  });

  // PATCH /api/v1/org/members/:userId — change role (owner only)
  router.patch('/members/:userId', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only owners can change roles.' } });
    }
    const userId = req.params.userId as string;
    if (!validateUuidParam(res, 'userId', userId)) return;
    const parsed = UpdateMemberRoleSchema.safeParse(req.body);
    if (!parsed.success) return sendZodFailure(res, 'Invalid role.', parsed.error.flatten());
    const { role } = parsed.data;
    await membershipRepo.updateRole(req.user!.orgId, userId, role);
    await recordAudit(db, {
      orgId: req.user!.orgId,
      actorId: req.user!.userId,
      action: 'member.role_changed',
      resourceType: 'member',
      resourceId: userId,
      metadata: { newRole: role },
    });
    res.json({ userId, role });
  });

  // POST /api/v1/org/invitations — send invitation
  router.post('/invitations', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CreateInvitationSchema.safeParse(req.body);
    if (!parsed.success) return sendZodFailure(res, 'Invalid invitation.', parsed.error.flatten());
    const result = await inviteToOrg.execute({
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      orgId: req.user!.orgId,
      email: parsed.data.email,
      role: parsed.data.role,
    });
    if (!result.ok) return sendDomainError(res, result.error);
    res.status(201).json(result.value);
  });

  // POST /api/v1/org/invitations/accept — accept invitation (public, requires auth)
  router.post('/invitations/accept', authMiddleware, async (req: Request, res: Response) => {
    const result = await acceptInvitation.execute({
      token: req.body.token,
      userId: req.user!.userId,
    });
    if (!result.ok) return sendDomainError(res, result.error);
    res.json(result.value);
  });

  // POST /api/v1/org/switch — switch active org, re-issue JWT
  router.post('/switch', authMiddleware, async (req: Request, res: Response) => {
    const parsed = SwitchOrgSchema.safeParse(req.body);
    if (!parsed.success) return sendZodFailure(res, 'Invalid switch request.', parsed.error.flatten());
    const { orgId } = parsed.data;

    const membership = await membershipRepo.findByOrgAndUser(orgId, req.user!.userId);
    if (!membership) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You are not a member of this organization.' } });
    }

    const token = tokenIssuer.sign({
      userId: req.user!.userId,
      email: req.user!.email,
      orgId: membership.orgId,
      role: membership.role,
      tokenVersion: (req as any).user!.tokenVersion ?? 0,
    });
    res.json({ token, orgId: membership.orgId, role: membership.role });
  });

  // POST /api/v1/org/revoke-sessions — invalidate all sessions for current user
  router.post('/revoke-sessions', authMiddleware, async (req: Request, res: Response) => {
    await userRepo.incrementTokenVersion(req.user!.userId);
    res.json({ message: 'All sessions revoked.' });
  });

  return router;
}
