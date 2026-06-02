import { Router, type Request, type Response, type NextFunction } from 'express';
import type { InviteToOrg } from '../../../domain/org/usecases/inviteToOrg.js';
import type { AcceptInvitation } from '../../../domain/org/usecases/acceptInvitation.js';
import type { MembershipRepo } from '../../../domain/auth/ports/MembershipRepo.js';
import type { OrgRepo } from '../../../domain/org/ports/OrgRepo.js';
import type { UserRepo } from '../../../domain/user/ports/UserRepo.js';
import type { TokenIssuer } from '../../../domain/auth/ports/TokenIssuer.js';
import { sendDomainError } from './errors.js';

export interface OrgRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  inviteToOrg: InviteToOrg;
  acceptInvitation: AcceptInvitation;
  membershipRepo: MembershipRepo;
  orgRepo: OrgRepo;
  userRepo: UserRepo;
  tokenIssuer: TokenIssuer;
}

export function createOrgRoutes(deps: OrgRouteDeps): Router {
  const router = Router();
  const { authMiddleware, inviteToOrg, acceptInvitation, membershipRepo, orgRepo, userRepo, tokenIssuer } = deps;

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
    const { name, slug } = req.body;
    const org = await orgRepo.update(req.user!.orgId, { name, slug });
    res.json({ org });
  });

  // GET /api/v1/org/members — list org members
  router.get('/members', authMiddleware, async (req: Request, res: Response) => {
    const memberships = await membershipRepo.listByOrg(req.user!.orgId);
    const members = await Promise.all(
      memberships.map(async (m) => {
        const user = await userRepo.findById(m.userId);
        return { userId: m.userId, role: m.role, email: user?.email, name: user?.name };
      }),
    );
    res.json({ members });
  });

  // DELETE /api/v1/org/members/:userId — remove member (owner/admin only)
  router.delete('/members/:userId', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }
    if (req.params.userId === req.user!.userId) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Cannot remove yourself.' } });
    }
    await membershipRepo.removeByOrgAndUser(req.user!.orgId, req.params.userId);
    res.status(204).end();
  });

  // PATCH /api/v1/org/members/:userId — change role (owner only)
  router.patch('/members/:userId', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only owners can change roles.' } });
    }
    const { role } = req.body;
    if (!role || !['owner', 'admin', 'member', 'viewer'].includes(role)) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid role.' } });
    }
    await membershipRepo.updateRole(req.user!.orgId, req.params.userId, role);
    res.json({ userId: req.params.userId, role });
  });

  // POST /api/v1/org/invitations — send invitation
  router.post('/invitations', authMiddleware, async (req: Request, res: Response) => {
    const result = await inviteToOrg.execute({
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      orgId: req.user!.orgId,
      email: req.body.email,
      role: req.body.role,
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
    const { orgId } = req.body;
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION', message: 'orgId is required.' } });

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
