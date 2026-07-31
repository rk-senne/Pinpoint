import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { sendZodFailure } from './errors.js';

export interface PremiumRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

/** Helper to emit a standard error envelope. */
function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = {
    error: { code, message },
  };
  if (details && Object.keys(details).length > 0) body.error.details = details;
  return res.status(status).json(body);
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
  email: z.string().email(),
  name: z.string().max(100).optional(),
});

const VoteSchema = z.object({
  email: z.string().email(),
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

  // ==================== PUBLIC FEEDBACK BOARD ====================

  // POST /api/v1/boards — create board (auth required)
  router.post('/boards', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CreateBoardSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid board payload.', parsed.error.flatten()); return; }
    const { projectId, title, slug, description } = parsed.data;
    const [board] = await db('feedback_boards').insert({ org_id: req.user!.orgId, project_id: projectId, slug, title, description }).returning('*');
    res.status(201).json({ board });
  });

  // GET /board/:slug — public board view
  router.get('/board/:slug', async (req: Request, res: Response) => {
    const board = await db('feedback_boards').where({ slug: req.params.slug, active: true }).first();
    if (!board) { sendError(res, 404, 'NOT_FOUND', 'Board not found'); return; }
    const posts = await db('board_posts').where('board_id', board.id).orderBy('vote_count', 'desc').limit(50);
    res.json({ board: { id: board.id, title: board.title, description: board.description }, posts });
  });

  // POST /board/:slug/posts — submit to public board
  router.post('/board/:slug/posts', async (req: Request, res: Response) => {
    const board = await db('feedback_boards').where({ slug: req.params.slug, active: true, allow_submissions: true }).first();
    if (!board) { sendError(res, 404, 'NOT_FOUND', 'Board not found or submissions disabled'); return; }
    const parsed = CreateBoardPostSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid post payload.', parsed.error.flatten()); return; }
    const { title, body, email, name } = parsed.data;
    const [post] = await db('board_posts').insert({ board_id: board.id, title, body, author_email: email, author_name: name }).returning('*');
    res.status(201).json({ post });
  });

  // POST /board/:slug/posts/:postId/vote — vote on a post
  router.post('/board/:slug/posts/:postId/vote', async (req: Request, res: Response) => {
    const parsed = VoteSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid vote payload.', parsed.error.flatten()); return; }
    const { email } = parsed.data;
    const board = await db('feedback_boards').where({ slug: req.params.slug }).first();
    if (!board) { sendError(res, 404, 'NOT_FOUND', 'Board not found'); return; }
    try {
      await db('board_votes').insert({ board_id: board.id, post_id: req.params.postId, voter_email: email });
      await db('board_posts').where('id', req.params.postId).increment('vote_count', 1);
      res.status(201).json({ voted: true });
    } catch { sendError(res, 409, 'CONFLICT', 'Already voted'); }
  });

  // ==================== SATISFACTION SCORING ====================

  // POST /api/v1/csat/request — request CSAT rating (called after annotation resolved)
  router.post('/csat/request', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CsatRequestSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid CSAT request.', parsed.error.flatten()); return; }
    const { annotationId } = parsed.data;
    const annotation = await db('annotations').where({ id: annotationId, org_id: req.user!.orgId, status: 'resolved' }).first();
    if (!annotation) { sendError(res, 404, 'NOT_FOUND', 'Resolved annotation not found'); return; }
    const token = randomBytes(32).toString('hex');
    await db('satisfaction_scores').insert({
      annotation_id: annotationId, org_id: req.user!.orgId,
      reporter_id: annotation.author_id, resolver_id: annotation.assignee_id, token,
    }).onConflict('annotation_id').ignore();
    res.status(201).json({ token, rateUrl: `/api/v1/csat/rate/${token}` });
  });

  // POST /api/v1/csat/rate/:token — submit rating (no auth, token-based)
  router.post('/csat/rate/:token', async (req: Request, res: Response) => {
    const parsed = CsatRateSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid rating.', parsed.error.flatten()); return; }
    const { score, comment } = parsed.data;
    const updated = await db('satisfaction_scores').where({ token: req.params.token }).whereNull('rated_at')
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

  router.post('/approvals/workflows', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CreateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid workflow.', parsed.error.flatten()); return; }
    const { name, projectId, steps } = parsed.data;
    const [workflow] = await db('approval_workflows').insert({
      org_id: req.user!.orgId, project_id: projectId, name, steps: JSON.stringify(steps),
    }).returning('*');
    res.status(201).json({ workflow });
  });

  router.get('/approvals/workflows', authMiddleware, async (req: Request, res: Response) => {
    const workflows = await db('approval_workflows').where('org_id', req.user!.orgId);
    res.json({ workflows });
  });

  router.post('/approvals/start', authMiddleware, async (req: Request, res: Response) => {
    const parsed = StartApprovalSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid approval start.', parsed.error.flatten()); return; }
    const { workflowId, annotationId } = parsed.data;
    const workflow = await db('approval_workflows').where({ id: workflowId, org_id: req.user!.orgId }).first();
    if (!workflow) { sendError(res, 404, 'NOT_FOUND', 'Workflow not found'); return; }
    const [instance] = await db('approval_instances').insert({ workflow_id: workflowId, annotation_id: annotationId }).returning('*');
    res.status(201).json({ instance });
  });

  router.post('/approvals/:instanceId/advance', authMiddleware, async (req: Request, res: Response) => {
    const instance = await db('approval_instances').where('id', req.params.instanceId).first();
    if (!instance) { sendError(res, 404, 'NOT_FOUND', 'Approval instance not found'); return; }
    const workflow = await db('approval_workflows').where('id', instance.workflow_id).first();
    const steps = typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : workflow.steps;
    const history = typeof instance.step_history === 'string' ? JSON.parse(instance.step_history) : (instance.step_history ?? []);
    history.push({ step: instance.current_step, userId: req.user!.userId, action: 'approved', completedAt: new Date() });
    const nextStep = instance.current_step + 1;
    const status = nextStep >= steps.length ? 'completed' : 'in_progress';
    await db('approval_instances').where('id', instance.id).update({ current_step: nextStep, status, step_history: JSON.stringify(history) });
    res.json({ status, currentStep: nextStep, totalSteps: steps.length });
  });

  return router;
}
