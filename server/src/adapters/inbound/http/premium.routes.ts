import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { sendZodFailure } from './errors.js';

export interface PremiumRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

export function createPremiumRoutes(deps: PremiumRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router();

  // ==================== PUBLIC FEEDBACK BOARD ====================

  // POST /api/v1/boards — create board (auth required)
  router.post('/boards', authMiddleware, async (req: Request, res: Response) => {
    const { projectId, title, slug, description } = req.body;
    if (!projectId || !title || !slug) { res.status(400).json({ error: { code: 'VALIDATION', message: 'projectId, title, slug required' } }); return; }
    const [board] = await db('feedback_boards').insert({ org_id: req.user!.orgId, project_id: projectId, slug, title, description }).returning('*');
    res.status(201).json({ board });
  });

  // GET /board/:slug — public board view
  router.get('/board/:slug', async (req: Request, res: Response) => {
    const board = await db('feedback_boards').where({ slug: req.params.slug, active: true }).first();
    if (!board) { res.status(404).json({ error: { code: 'NOT_FOUND' } }); return; }
    const posts = await db('board_posts').where('board_id', board.id).orderBy('vote_count', 'desc').limit(50);
    res.json({ board: { id: board.id, title: board.title, description: board.description }, posts });
  });

  // POST /board/:slug/posts — submit to public board
  router.post('/board/:slug/posts', async (req: Request, res: Response) => {
    const board = await db('feedback_boards').where({ slug: req.params.slug, active: true, allow_submissions: true }).first();
    if (!board) { res.status(404).end(); return; }
    const { title, body, email, name } = req.body;
    if (!title || !body || !email) { res.status(400).json({ error: { code: 'VALIDATION', message: 'title, body, email required' } }); return; }
    const [post] = await db('board_posts').insert({ board_id: board.id, title, body, author_email: email, author_name: name }).returning('*');
    res.status(201).json({ post });
  });

  // POST /board/:slug/posts/:postId/vote — vote on a post
  router.post('/board/:slug/posts/:postId/vote', async (req: Request, res: Response) => {
    const { email } = req.body;
    if (!email) { res.status(400).json({ error: { code: 'VALIDATION', message: 'email required' } }); return; }
    const board = await db('feedback_boards').where({ slug: req.params.slug }).first();
    if (!board) { res.status(404).end(); return; }
    try {
      await db('board_votes').insert({ board_id: board.id, post_id: req.params.postId, voter_email: email });
      await db('board_posts').where('id', req.params.postId).increment('vote_count', 1);
      res.status(201).json({ voted: true });
    } catch { res.status(409).json({ error: { code: 'DUPLICATE', message: 'Already voted' } }); }
  });

  // ==================== SATISFACTION SCORING ====================

  // POST /api/v1/csat/request — request CSAT rating (called after annotation resolved)
  router.post('/csat/request', authMiddleware, async (req: Request, res: Response) => {
    const { annotationId } = req.body;
    if (!annotationId) { res.status(400).end(); return; }
    const annotation = await db('annotations').where({ id: annotationId, org_id: req.user!.orgId, status: 'resolved' }).first();
    if (!annotation) { res.status(404).end(); return; }
    const token = randomBytes(32).toString('hex');
    await db('satisfaction_scores').insert({
      annotation_id: annotationId, org_id: req.user!.orgId,
      reporter_id: annotation.author_id, resolver_id: annotation.assignee_id, token,
    }).onConflict('annotation_id').ignore();
    res.status(201).json({ token, rateUrl: `/api/v1/csat/rate/${token}` });
  });

  // POST /api/v1/csat/rate/:token — submit rating (no auth, token-based)
  router.post('/csat/rate/:token', async (req: Request, res: Response) => {
    const { score, comment } = req.body;
    if (!score || score < 1 || score > 5) { res.status(400).json({ error: { message: 'score 1-5 required' } }); return; }
    const updated = await db('satisfaction_scores').where({ token: req.params.token }).whereNull('rated_at')
      .update({ score, comment, rated_at: new Date() });
    if (!updated) { res.status(404).json({ error: { message: 'Invalid or already rated' } }); return; }
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
    const { name, projectId, steps } = req.body;
    if (!name || !steps?.length) { res.status(400).end(); return; }
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
    const { workflowId, annotationId } = req.body;
    const workflow = await db('approval_workflows').where({ id: workflowId, org_id: req.user!.orgId }).first();
    if (!workflow) { res.status(404).end(); return; }
    const [instance] = await db('approval_instances').insert({ workflow_id: workflowId, annotation_id: annotationId }).returning('*');
    res.status(201).json({ instance });
  });

  router.post('/approvals/:instanceId/advance', authMiddleware, async (req: Request, res: Response) => {
    const instance = await db('approval_instances').where('id', req.params.instanceId).first();
    if (!instance) { res.status(404).end(); return; }
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
