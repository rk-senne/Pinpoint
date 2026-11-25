import { systemScope } from '../../../infrastructure/tenantContext.js';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { CreateCheckoutSession, HandleStripeWebhook, GetBillingPortal, GetUsageSummary } from '../../../domain/billing/usecases/billing.js';
import type { Knex } from 'knex';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';
import { sendError, sendZodFailure } from './errors.js';
import { requireOrgAdmin } from './access.js';

type LoggedRequest = Request & { log?: { error: (obj: object, msg: string) => void } };

/**
 * Log the real failure server-side (pino request logger) and answer with a
 * generic message — Stripe / SDK / SQL error text must never reach clients.
 */
function billingFailure(req: Request, res: Response, e: unknown, status = 500, code = 'BILLING_ERROR'): void {
  (req as LoggedRequest).log?.error({ err: e }, 'Billing request failed');
  sendError(res, status, code, 'Billing request failed.');
}

// --- Zod schemas for billing route inputs ---

/** Validates checkout URLs to prevent SSRF. Only allows http(s) with no IP addresses. */
const CheckoutSchema = z.object({
  successUrl: z.string().url().refine(
    (url) => /^https?:\/\//.test(url) && !/\d+\.\d+\.\d+\.\d+/.test(url),
    { message: 'successUrl must be a valid HTTP(S) URL without IP addresses' },
  ),
  cancelUrl: z.string().url().refine(
    (url) => /^https?:\/\//.test(url) && !/\d+\.\d+\.\d+\.\d+/.test(url),
    { message: 'cancelUrl must be a valid HTTP(S) URL without IP addresses' },
  ),
});

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
  router.post('/checkout', authMiddleware, requireOrgAdmin, async (req: Request, res: Response) => {
    try {
      const parsed = CheckoutSchema.safeParse(req.body);
      if (!parsed.success) {
        sendZodFailure(res, 'Invalid checkout URLs', parsed.error.flatten());
        return;
      }
      const { successUrl, cancelUrl } = parsed.data;
      const url = await createCheckoutSession.execute(
        req.user!.orgId,
        req.user!.email,
        req.user!.orgId, // orgName fallback
        successUrl,
        cancelUrl,
      );
      res.json({ url });
    } catch (e: unknown) {
      billingFailure(req, res, e);
    }
  });

  // POST /api/v1/billing/webhook — Stripe webhook (no auth, signature verified)
  router.post('/webhook', systemScope, async (req: Request, res: Response) => {
    try {
      const signature = req.headers['stripe-signature'] as string;
      if (!signature) { sendError(res, 400, 'MISSING_SIGNATURE', 'stripe-signature header is required'); return; }
      // The raw body buffer is preserved by express.json({ verify }) in container.ts.
      // Stripe signature verification MUST use the exact bytes that were signed;
      // JSON.stringify(req.body) may produce a different string, so we fail fast
      // if the raw buffer is missing rather than silently submitting an invalid payload.
      const rawBody: Buffer | undefined = req.rawBody;
      if (!rawBody) {
        sendError(res, 400, 'MISSING_RAW_BODY', 'Raw request body unavailable — cannot verify Stripe signature');
        return;
      }
      const body = rawBody.toString('utf8');
      await handleStripeWebhook.execute(body, signature);
      res.json({ received: true });
    } catch (e: unknown) {
      billingFailure(req, res, e, 400, 'WEBHOOK_ERROR');
    }
  });

  // GET /api/v1/billing/portal — billing portal URL
  router.get('/portal', authMiddleware, requireOrgAdmin, async (req: Request, res: Response) => {
    try {
      const returnUrl = (req.query.returnUrl as string) || req.headers.referer || '/';
      const url = await getBillingPortal.execute(req.user!.orgId, returnUrl);
      res.json({ url });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'NO_STRIPE_CUSTOMER') {
        sendError(res, 404, 'NO_SUBSCRIPTION', 'No active subscription for this organization.');
        return;
      }
      billingFailure(req, res, e);
    }
  });

  // GET /api/v1/billing/usage — current period usage summary
  router.get('/usage', authMiddleware, async (req: Request, res: Response) => {
    try {
      const summary = await getUsageSummary.execute(req.user!.orgId);
      res.json(summary);
    } catch (e: unknown) {
      billingFailure(req, res, e);
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
    } catch (e: unknown) {
      billingFailure(req, res, e);
    }
  });

  // GET /api/v1/billing/invoices — invoice history (Task 2)
  router.get('/invoices', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { page, pageSize } = PaginationParamsSchema.parse(req.query);
      const base = db('subscription_events')
        .where({ org_id: req.user!.orgId })
        .where('event_type', 'like', 'invoice.%');
      const [{ count: total }] = await base.clone().count('* as count');
      const rows = await base
        .clone()
        .orderBy('created_at', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const data = rows.map((r: any) => {
        const payload = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data ?? {});
        return {
          id: r.id,
          event_type: r.event_type,
          amount: payload.amount ?? payload.amount_paid ?? null,
          status: payload.status ?? r.event_type.replace('invoice.', ''),
          created_at: r.created_at,
        };
      });
      res.json({ data, pagination: paginationMeta(Number(total), page, pageSize) });
    } catch (e: unknown) {
      billingFailure(req, res, e);
    }
  });

  return router;
}
