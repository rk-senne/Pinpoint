import { Router, type Request, type Response, type NextFunction } from 'express';
import type { CreateCheckoutSession, HandleStripeWebhook, GetBillingPortal, GetUsageSummary } from '../../../domain/billing/usecases/billing.js';
import type { Knex } from 'knex';

/** Helper to emit a standard error envelope from catch blocks. */
function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = {
    error: { code, message },
  };
  if (details && Object.keys(details).length > 0) body.error.details = details;
  return res.status(status).json(body);
}

export interface BillingRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  createCheckoutSession: CreateCheckoutSession;
  handleStripeWebhook: HandleStripeWebhook;
  getBillingPortal: GetBillingPortal;
  getUsageSummary: GetUsageSummary;
  db: Knex;
}

export function createBillingRoutes(deps: BillingRouteDeps): Router {
  const { authMiddleware, createCheckoutSession, handleStripeWebhook, getBillingPortal, getUsageSummary, db } = deps;
  const router = Router();

  // POST /api/v1/billing/checkout — create Stripe checkout session
  router.post('/checkout', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { successUrl, cancelUrl } = req.body;
      if (!successUrl || !cancelUrl) {
        sendError(res, 400, 'VALIDATION', 'successUrl and cancelUrl required');
        return;
      }
      const url = await createCheckoutSession.execute(
        req.user!.orgId,
        req.user!.email,
        req.user!.orgId, // orgName fallback
        successUrl,
        cancelUrl,
      );
      res.json({ url });
    } catch (e: any) {
      sendError(res, 500, 'BILLING_ERROR', e.message);
    }
  });

  // POST /api/v1/billing/webhook — Stripe webhook (no auth, signature verified)
  router.post('/webhook', async (req: Request, res: Response) => {
    try {
      const signature = req.headers['stripe-signature'] as string;
      if (!signature) { sendError(res, 400, 'MISSING_SIGNATURE', 'stripe-signature header is required'); return; }
      // Body must be raw string for signature verification
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      await handleStripeWebhook.execute(body, signature);
      res.json({ received: true });
    } catch (e: any) {
      sendError(res, 400, 'WEBHOOK_ERROR', e.message);
    }
  });

  // GET /api/v1/billing/portal — billing portal URL
  router.get('/portal', authMiddleware, async (req: Request, res: Response) => {
    try {
      const returnUrl = (req.query.returnUrl as string) || req.headers.referer || '/';
      const url = await getBillingPortal.execute(req.user!.orgId, returnUrl);
      res.json({ url });
    } catch (e: any) {
      const code = e.message === 'NO_STRIPE_CUSTOMER' ? 'NO_SUBSCRIPTION' : 'BILLING_ERROR';
      const status = e.message === 'NO_STRIPE_CUSTOMER' ? 404 : 500;
      sendError(res, status, code, e.message);
    }
  });

  // GET /api/v1/billing/usage — current period usage summary
  router.get('/usage', authMiddleware, async (req: Request, res: Response) => {
    try {
      const summary = await getUsageSummary.execute(req.user!.orgId);
      res.json(summary);
    } catch (e: any) {
      sendError(res, 500, 'BILLING_ERROR', e.message);
    }
  });

  // GET /api/v1/billing/subscription — current subscription status
  router.get('/subscription', authMiddleware, async (req: Request, res: Response) => {
    try {
      const org = await db('organizations').where({ id: req.user!.orgId }).first();
      if (!org) { sendError(res, 404, 'NOT_FOUND', 'Organization not found'); return; }
      res.json({
        plan: org.plan,
        status: org.plan_status || 'active',
        stripeSubscriptionId: org.stripe_subscription_id || null,
      });
    } catch (e: any) {
      sendError(res, 500, 'BILLING_ERROR', e.message);
    }
  });

  // GET /api/v1/billing/invoices — invoice history (Task 2)
  router.get('/invoices', authMiddleware, async (req: Request, res: Response) => {
    try {
      const rows = await db('subscription_events')
        .where({ org_id: req.user!.orgId })
        .where('event_type', 'like', 'invoice.%')
        .orderBy('created_at', 'desc')
        .limit(50);
      const invoices = rows.map((r: any) => {
        const data = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data ?? {});
        return {
          id: r.id,
          event_type: r.event_type,
          amount: data.amount ?? data.amount_paid ?? null,
          status: data.status ?? r.event_type.replace('invoice.', ''),
          created_at: r.created_at,
        };
      });
      res.json({ invoices });
    } catch (e: any) {
      sendError(res, 500, 'BILLING_ERROR', e.message);
    }
  });

  return router;
}
