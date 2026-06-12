import { Router, type Request, type Response, type NextFunction } from 'express';
import type { CreateCheckoutSession, HandleStripeWebhook, GetBillingPortal, GetUsageSummary } from '../../../domain/billing/usecases/billing.js';
import type { Knex } from 'knex';

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
        res.status(400).json({ error: { code: 'VALIDATION', message: 'successUrl and cancelUrl required' } });
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
      res.status(500).json({ error: { code: 'BILLING_ERROR', message: e.message } });
    }
  });

  // POST /api/v1/billing/webhook — Stripe webhook (no auth, signature verified)
  router.post('/webhook', async (req: Request, res: Response) => {
    try {
      const signature = req.headers['stripe-signature'] as string;
      if (!signature) { res.status(400).json({ error: { code: 'MISSING_SIGNATURE' } }); return; }
      // Body must be raw string for signature verification
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      await handleStripeWebhook.execute(body, signature);
      res.json({ received: true });
    } catch (e: any) {
      res.status(400).json({ error: { code: 'WEBHOOK_ERROR', message: e.message } });
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
      res.status(e.message === 'NO_STRIPE_CUSTOMER' ? 404 : 500).json({ error: { code, message: e.message } });
    }
  });

  // GET /api/v1/billing/usage — current period usage summary
  router.get('/usage', authMiddleware, async (req: Request, res: Response) => {
    try {
      const summary = await getUsageSummary.execute(req.user!.orgId);
      res.json(summary);
    } catch (e: any) {
      res.status(500).json({ error: { code: 'BILLING_ERROR', message: e.message } });
    }
  });

  // GET /api/v1/billing/subscription — current subscription status
  router.get('/subscription', authMiddleware, async (req: Request, res: Response) => {
    try {
      const org = await db('organizations').where({ id: req.user!.orgId }).first();
      if (!org) { res.status(404).json({ error: { code: 'NOT_FOUND' } }); return; }
      res.json({
        plan: org.plan,
        status: org.plan_status || 'active',
        stripeSubscriptionId: org.stripe_subscription_id || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: { code: 'BILLING_ERROR', message: e.message } });
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
      res.status(500).json({ error: { code: 'BILLING_ERROR', message: e.message } });
    }
  });

  return router;
}
