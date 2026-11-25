import { systemScope } from '../../../infrastructure/tenantContext.js';
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
import { registerSessionDb } from './access.js';
import { buildSessionCookie } from '../../../middleware/sessionCookies.js';

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

const AcceptInvitationSchema = z.object({
  token: z.string().min(1).max(256),
});

const SwitchOrgSchema = z.object({
  orgId: z.string().uuid(),
});

const CreateInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

export interface OrgRouteDeps {
  /** Mirrors the auth routes: drop the Secure flag on plain-HTTP local stacks. */
  cookieInsecure?: boolean;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  inviteToOrg: InviteToOrg;
  acceptInvitation: AcceptInvitation;
  membershipRepo: MembershipRepo;
  orgRepo: OrgRepo;
  userRepo: UserRepo;
  tokenIssuer: TokenIssuer;
  /** Disconnect a user's live realtime sockets (PP-02). */
  revokeUserSockets?: (userId: string) => void;
  db: Knex;
}

export function createOrgRoutes(deps: OrgRouteDeps): Router {
  const router = Router();
  const { authMiddleware, inviteToOrg, acceptInvitation, membershipRepo, orgRepo, userRepo, tokenIssuer, db } = deps;
  registerSessionDb(db);

  /** Owners currently in the org (used to protect the last owner). */
  async function countOwners(orgId: string): Promise<number> {
    const members = await membershipRepo.listByOrg(orgId);
    return members.filter((m) => m.role === 'owner').length;
  }

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
      request: req,
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
    // Return paginated envelope for API consistency (MISSION-A2).
    // Org members are typically small lists, so we paginate client-side.
    res.json({
      data: members,
      pagination: { page: 1, pageSize: members.length, total: members.length, totalPages: 1 },
    });
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
    const orgId = req.user!.orgId;
    const target = await membershipRepo.findByOrgAndUser(orgId, userId);
    if (!target) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found.' } });
    }
    // Admins cannot remove owners (or, by extension, escalate over them).
    if (target.role === 'owner') {
      if (req.user!.role !== 'owner') {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only owners can remove an owner.' } });
      }
      if ((await countOwners(orgId)) <= 1) {
        return res.status(409).json({ error: { code: 'CONFLICT', message: 'Cannot remove the last owner.' } });
      }
    }
    await membershipRepo.removeByOrgAndUser(orgId, userId);
    // Cut off everything the removed user could still do:
    //  - bump token_version so every outstanding JWT is rejected,
    //  - revoke the API keys they minted for this org (keys act as their creator).
    await userRepo.incrementTokenVersion(userId);
    await db('api_keys')
      .where({ org_id: orgId, created_by: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: db.fn.now() });
    await recordAudit(db, {
      request: req,
      orgId,
      actorId: req.user!.userId,
      action: 'member.removed',
      resourceType: 'member',
      resourceId: userId,
      metadata: { role: target.role },
    });
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
    const target = await membershipRepo.findByOrgAndUser(req.user!.orgId, userId);
    if (!target) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found.' } });
    }
    // Never demote the last owner (the org would become unmanageable).
    if (target.role === 'owner' && role !== 'owner' && (await countOwners(req.user!.orgId)) <= 1) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Cannot demote the last owner.' } });
    }
    await membershipRepo.updateRole(req.user!.orgId, userId, role);
    // Demotion must cut live rooms joined under the old role (PP-02).
    deps.revokeUserSockets?.(userId);
    await recordAudit(db, {
      request: req,
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
    const [org, inviter] = await Promise.all([
      orgRepo.findById(req.user!.orgId),
      userRepo.findById(req.user!.userId),
    ]);
    const result = await inviteToOrg.execute({
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      orgId: req.user!.orgId,
      email: parsed.data.email,
      role: parsed.data.role,
      ...(org ? { orgName: org.name } : {}),
      ...(inviter ? { inviterName: inviter.name } : {}),
    });
    if (!result.ok) return sendDomainError(res, result.error);
    // The raw token is delivered ONLY by email to the invited address; it is
    // deliberately absent from this response.
    const { invitationId, email, role, expiresAt } = result.value;
    res.status(201).json({ invitationId, email, role, expiresAt });
  });

  // POST /api/v1/org/invitations/accept — accept invitation (requires auth)
  router.post('/invitations/accept', authMiddleware, systemScope, async (req: Request, res: Response) => {
    const parsedBody = AcceptInvitationSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) return sendZodFailure(res, 'Invalid invitation token.', parsedBody.error.flatten());
    // Bind redemption to the invited email using the account's CURRENT email.
    const account = await userRepo.findById(req.user!.userId);
    if (!account) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session is no longer valid.' } });
    const result = await acceptInvitation.execute({
      token: parsedBody.data.token,
      userId: req.user!.userId,
      userEmail: account.email,
    });
    if (!result.ok) return sendDomainError(res, result.error);
    res.json(result.value);
  });

  // POST /api/v1/org/switch — switch active org, re-issue JWT
  router.post('/switch', authMiddleware, systemScope, async (req: Request, res: Response) => {
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
      // PP-15: switching org must not reset the absolute session lifetime
      // (nor orphan the session-bound CSRF token).
      ...(req.user!.sessionStart !== undefined ? { sessionStart: req.user!.sessionStart } : {}),
    });
    // The dashboard authenticates with the HttpOnly session cookie, so the
    // switch must replace it too — returning the token only in the body
    // left cookie sessions on the old org. CSRF cookie is unchanged.
    res.setHeader('Set-Cookie', buildSessionCookie(token, !!deps.cookieInsecure));
    res.json({ token, orgId: membership.orgId, role: membership.role });
  });

  // POST /api/v1/org/revoke-sessions — invalidate all sessions for current user
  router.post('/revoke-sessions', authMiddleware, async (req: Request, res: Response) => {
    await userRepo.incrementTokenVersion(req.user!.userId);
    res.json({ message: 'All sessions revoked.' });
  });

  return router;
}
