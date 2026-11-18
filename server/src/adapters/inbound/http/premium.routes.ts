import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';
import { sendError, sendZodFailure } from './errors.js';
import {
  findAccessibleAnnotation,
  findAccessibleProject,
  isUuid,
  registerSessionDb,
  requireOrgAdmin,
} from './access.js';

/** Columns of `board_posts` that are safe to show publicly (never `author_email`). */
const PUBLIC_POST_COLUMNS = ['id', 'title', 'body', 'author_name', 'status', 'vote_count', 'created_at'] as const;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface PremiumRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

// --- Zod schemas for premium route inputs ---

const CreateBoardSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens').min(2).max(80),
  description: z.string().max(1000).optional(),
});

const CreateBoardPostSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  email: z.string().email().max(254),
  name: z.string().max(100).optional(),
});

const VoteSchema = z.object({
  email: z.string().email().max(254),
});

const CsatRequestSchema = z.object({
  annotationId: z.string().uuid(),
});

const CsatRateSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  projectId: z.string().uuid().optional(),
  steps: z.array(z.object({
    approver: z.string().min(1),
    role: z.string().optional(),
  })).min(1).max(20),
});

const StartApprovalSchema = z.object({
  workflowId: z.string().uuid(),
  annotationId: z.string().uuid(),
});

export function createPremiumRoutes(deps: PremiumRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router();
  registerSessionDb(db);

  // ==================== PUBLIC FEEDBACK BOARD ====================

  // POST /api/v1/boards — create board (auth required)
  router.post('/boards', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CreateBoardSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid board payload.', parsed.error.flatten()); return; }
    const { projectId, title, slug, description } = parsed.data;

    // Org match + owner/team-member access (prevent cross-tenant IDOR)
    const project = await findAccessibleProject(db, req.user!, projectId);
    if (!project) { sendError(res, 403, 'FORBIDDEN', 'Project not in your organization'); return; }

    const [board] = await db('feedback_boards').insert({ org_id: req.user!.orgId, project_id: projectId, slug, title, description }).returning('*');
    res.status(201).json({ board });
  });

  // GET /board/:slug — public board view
  router.get('/board/:slug', async (req: Request, res: Response) => {
    const board = await db('feedback_boards').where({ slug: req.params.slug, active: true }).first();
    if (!board) { sendError(res, 404, 'NOT_FOUND', 'Board not found'); return; }
    const posts = await db('board_posts').where('board_id', board.id).select([...PUBLIC_POST_COLUMNS]).orderBy('vote_count', 'desc').limit(50);
    res.json({ board: { id: board.id, title: board.title, description: board.description }, posts });
  });

  // POST /board/:slug/posts — submit to public board
  router.post('/board/:slug/posts', async (req: Request, res: Response) => {
    const board = await db('feedback_boards').where({ slug: req.params.slug, active: true, allow_submissions: true }).first();
    if (!board) { sendError(res, 404, 'NOT_FOUND', 'Board not found or submissions disabled'); return; }
    const parsed = CreateBoardPostSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid post payload.', parsed.error.flatten()); return; }
    const { title, body, email, name } = parsed.data;
    const [post] = await db('board_posts').insert({ board_id: board.id, title, body, author_email: email.toLowerCase(), author_name: name }).returning([...PUBLIC_POST_COLUMNS]);
    res.status(201).json({ post });
  });

  // POST /board/:slug/posts/:postId/vote — vote on a post
  router.post('/board/:slug/posts/:postId/vote', async (req: Request, res: Response) => {
    const parsed = VoteSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid vote payload.', parsed.error.flatten()); return; }
    const voter = parsed.data.email.trim().toLowerCase();
    const postId = String(req.params.postId);
    const board = await db('feedback_boards').where({ slug: req.params.slug, active: true }).first();
    // Same 404 for "no such board" and "post not on this board" (no probing).
    if (!board || !isUuid(postId)) { sendError(res, 404, 'NOT_FOUND', 'Post not found'); return; }

    const voted = await db.transaction(async (trx) => {
      // The post must belong to the board named in the URL.
      const post = await trx('board_posts').where({ id: postId, board_id: board.id }).first('id');
      if (!post) return 'missing' as const;
      // One vote per voter per post; the PK (post_id, voter_email) makes the
      // insert the atomic dedupe point, and the counter only moves when a new
      // row was actually inserted.
      const inserted = await trx('board_votes')
        .insert({ board_id: board.id, post_id: postId, voter_email: voter })
        .onConflict(['post_id', 'voter_email'])
        .ignore()
        .returning('post_id');
      if (!inserted.length) return 'duplicate' as const;
      await trx('board_posts').where({ id: postId, board_id: board.id }).increment('vote_count', 1);
      return 'ok' as const;
    });
    if (voted === 'missing') { sendError(res, 404, 'NOT_FOUND', 'Post not found'); return; }
    if (voted === 'duplicate') { sendError(res, 409, 'CONFLICT', 'Already voted'); return; }
    res.status(201).json({ voted: true });
  });

  // ==================== SATISFACTION SCORING ====================

  // POST /api/v1/csat/request — request CSAT rating (called after annotation resolved)
  //
  // The rating token is a bearer secret meant for the REPORTER (end user), so
  // it is delivered to the reporter as an in-app notification and is never
  // returned to the requester — otherwise a teammate could rate on the
  // reporter's behalf.
  router.post('/csat/request', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CsatRequestSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid CSAT request.', parsed.error.flatten()); return; }
    const { annotationId } = parsed.data;
    if (!(await findAccessibleAnnotation(db, req.user!, annotationId))) { sendError(res, 404, 'NOT_FOUND', 'Resolved annotation not found'); return; }
    const annotation = await db('annotations').where({ id: annotationId, org_id: req.user!.orgId, status: 'resolved' }).first();
    if (!annotation) { sendError(res, 404, 'NOT_FOUND', 'Resolved annotation not found'); return; }
    if (!annotation.author_id) { sendError(res, 409, 'CONFLICT', 'This feedback has no registered reporter to survey.'); return; }
    const token = randomBytes(32).toString('hex');
    const inserted = await db('satisfaction_scores').insert({
      annotation_id: annotationId, org_id: req.user!.orgId,
      reporter_id: annotation.author_id, resolver_id: annotation.assignee_id, token: sha256(token),
    }).onConflict('annotation_id').ignore().returning('id');
    if (inserted.length) {
      await db('user_notifications').insert({
        user_id: annotation.author_id,
        org_id: req.user!.orgId,
        type: 'csat_request',
        title: 'How did we do? Rate the resolution of your feedback',
        body: null,
        metadata: JSON.stringify({ annotationId, rateUrl: `/api/v1/csat/rate/${token}` }),
      });
    }
    res.status(201).json({ requested: true });
  });

  // POST /api/v1/csat/rate/:token — submit rating (no auth, token-based)
  router.post('/csat/rate/:token', async (req: Request, res: Response) => {
    const parsed = CsatRateSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid rating.', parsed.error.flatten()); return; }
    const { score, comment } = parsed.data;
    const updated = await db('satisfaction_scores').where({ token: sha256(String(req.params.token)) }).whereNull('rated_at')
      .update({ score, comment, rated_at: new Date() });
    if (!updated) { sendError(res, 404, 'NOT_FOUND', 'Invalid or already rated'); return; }
    res.json({ success: true });
  });

  // GET /api/v1/csat/summary — org CSAT summary
  router.get('/csat/summary', authMiddleware, async (req: Request, res: Response) => {
    const summary = await db('satisfaction_scores').where('org_id', req.user!.orgId).whereNotNull('score')
      .select(db.raw('AVG(score) as avg_score, COUNT(*) as total_ratings'));
    res.json(summary?.[0] ?? { avg_score: null, total_ratings: 0 });
  });

  // ==================== APPROVAL WORKFLOWS ====================

  router.post('/approvals/workflows', authMiddleware, requireOrgAdmin, async (req: Request, res: Response) => {
    const parsed = CreateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid workflow.', parsed.error.flatten()); return; }
    const { name, projectId, steps } = parsed.data;

    // Verify the caller can access the project when provided (prevent cross-tenant IDOR)
    if (projectId) {
      const project = await findAccessibleProject(db, req.user!, projectId);
      if (!project) { sendError(res, 403, 'FORBIDDEN', 'Project not in your organization'); return; }
    }

    const [workflow] = await db('approval_workflows').insert({
      org_id: req.user!.orgId, project_id: projectId, name, steps: JSON.stringify(steps),
    }).returning('*');
    res.status(201).json({ workflow });
  });

  router.get('/approvals/workflows', authMiddleware, async (req: Request, res: Response) => {
    const { page, pageSize } = PaginationParamsSchema.parse(req.query);
    const base = db('approval_workflows').where('org_id', req.user!.orgId);
    const [{ count: total }] = await base.clone().count('* as count');
    const data = await base
      .clone()
      .orderBy('created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    res.json({ data, pagination: paginationMeta(Number(total), page, pageSize) });
  });

  router.post('/approvals/start', authMiddleware, async (req: Request, res: Response) => {
    const parsed = StartApprovalSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid approval start.', parsed.error.flatten()); return; }
    const { workflowId, annotationId } = parsed.data;
    const workflow = await db('approval_workflows').where({ id: workflowId, org_id: req.user!.orgId }).first();
    if (!workflow) { sendError(res, 404, 'NOT_FOUND', 'Workflow not found'); return; }

    // Verify the annotation is in the caller's org AND its project is accessible
    if (!(await findAccessibleAnnotation(db, req.user!, annotationId))) { sendError(res, 404, 'NOT_FOUND', 'Annotation not found'); return; }

    const [instance] = await db('approval_instances').insert({ workflow_id: workflowId, annotation_id: annotationId }).returning('*');
    res.status(201).json({ instance });
  });

  router.post('/approvals/:instanceId/advance', authMiddleware, async (req: Request, res: Response) => {
    const instanceId = String(req.params.instanceId);
    if (!isUuid(instanceId)) { sendError(res, 404, 'NOT_FOUND', 'Approval instance not found'); return; }

    type Outcome =
      | { kind: 'not_found' }
      | { kind: 'forbidden' }
      | { kind: 'conflict' }
      | { kind: 'ok'; status: string; currentStep: number; totalSteps: number };

    const outcome = await db.transaction(async (trx): Promise<Outcome> => {
      // Row lock on the instance (joined through the workflow so the org
      // check — prevent cross-tenant IDOR — happens in the same statement).
      // Concurrent advances serialise here instead of both reading step N.
      const instance = await trx('approval_instances')
        .join('approval_workflows', 'approval_workflows.id', 'approval_instances.workflow_id')
        .where({ 'approval_instances.id': instanceId, 'approval_workflows.org_id': req.user!.orgId })
        .select('approval_instances.*')
        .forUpdate('approval_instances')
        .first();
      if (!instance) return { kind: 'not_found' };
      if (instance.status !== 'in_progress') return { kind: 'conflict' };

      const workflow = await trx('approval_workflows').where('id', instance.workflow_id).first();
      const steps = typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : workflow.steps;
      const step = steps[instance.current_step];
      if (!step) return { kind: 'conflict' };

      // Only the step's assigned approver (user id or email) or an org
      // owner/admin may decide.
      const isAdmin = req.user!.role === 'owner' || req.user!.role === 'admin';
      const approver = String(step.approver ?? '').trim().toLowerCase();
      const isAssigned =
        approver.length > 0 &&
        (approver === req.user!.userId.toLowerCase() || approver === String(req.user!.email ?? '').toLowerCase());
      if (!isAdmin && !isAssigned) return { kind: 'forbidden' };

      const history = typeof instance.step_history === 'string' ? JSON.parse(instance.step_history) : (instance.step_history ?? []);
      history.push({ step: instance.current_step, userId: req.user!.userId, action: 'approved', completedAt: new Date() });
      const nextStep = instance.current_step + 1;
      const status = nextStep >= steps.length ? 'completed' : 'in_progress';

      // Conditional update as a second guard: only advance from the step we
      // actually read, while still in progress.
      const updated = await trx('approval_instances')
        .where({ id: instance.id, current_step: instance.current_step, status: 'in_progress' })
        .update({ current_step: nextStep, status, step_history: JSON.stringify(history) });
      if (!updated) return { kind: 'conflict' };
      return { kind: 'ok', status, currentStep: nextStep, totalSteps: steps.length };
    });

    if (outcome.kind === 'not_found') { sendError(res, 404, 'NOT_FOUND', 'Approval instance not found'); return; }
    if (outcome.kind === 'forbidden') { sendError(res, 403, 'FORBIDDEN', 'You are not an approver for this step'); return; }
    if (outcome.kind === 'conflict') { sendError(res, 409, 'CONFLICT', 'Approval instance is not awaiting a decision'); return; }
    res.json({ status: outcome.status, currentStep: outcome.currentStep, totalSteps: outcome.totalSteps });
  });

  return router;
}
