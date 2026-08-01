import type { Knex } from 'knex';
import type { BillingProvider, StripeEvent } from '../ports/BillingProvider.js';

// --- Plan limits constants ---
export const PLAN_LIMITS = {
  free: { seats: 2, annotationsPerMonth: 50, projects: 2 },
  pro: { seats: 10, annotationsPerMonth: Infinity, projects: Infinity },
  enterprise: { seats: Infinity, annotationsPerMonth: Infinity, projects: Infinity },
} as const;

export type PlanName = keyof typeof PLAN_LIMITS;

// --- Deps ---
export interface BillingDeps {
  db: Knex;
  billingProvider: BillingProvider;
  proPriceId: string;
}

// --- CreateCheckoutSession ---
export class CreateCheckoutSession {
  constructor(private readonly deps: BillingDeps) {}

  async execute(orgId: string, email: string, orgName: string, successUrl: string, cancelUrl: string): Promise<string> {
    const { db, billingProvider, proPriceId } = this.deps;
    const org = await db('organizations').where({ id: orgId }).first();
    if (!org) throw new Error('ORG_NOT_FOUND');

    let customerId = org.stripe_customer_id as string | null;
    if (!customerId) {
      customerId = await billingProvider.createCustomer(orgId, email, orgName);
      await db('organizations').where({ id: orgId }).update({ stripe_customer_id: customerId });
    }

    return billingProvider.createCheckoutSession(customerId, proPriceId, successUrl, cancelUrl);
  }
}

// --- HandleStripeWebhook ---
export class HandleStripeWebhook {
  constructor(private readonly deps: BillingDeps) {}

  async execute(body: string, signature: string): Promise<void> {
    const { db, billingProvider } = this.deps;
    const event: StripeEvent = await billingProvider.constructWebhookEvent(body, signature);

    // Idempotency — skip already-processed events
    const existing = await db('subscription_events').where({ stripe_event_id: event.id }).first();
    if (existing) return;

    await db('subscription_events').insert({
      org_id: (event.data as Record<string, unknown>).orgId ?? await this.resolveOrgId(event),
      stripe_event_id: event.id,
      event_type: event.type,
      data: JSON.stringify(event.data),
      processed_at: new Date(),
    });

    if (event.type === 'checkout.session.completed') {
      const customerId = (event.data as Record<string, unknown>).customer as string;
      const subscriptionId = (event.data as Record<string, unknown>).subscription as string;
      await db('organizations').where({ stripe_customer_id: customerId }).update({
        plan: 'pro',
        stripe_subscription_id: subscriptionId,
        plan_status: 'active',
      });
    } else if (event.type === 'customer.subscription.deleted') {
      const customerId = (event.data as Record<string, unknown>).customer as string;
      await db('organizations').where({ stripe_customer_id: customerId }).update({
        plan: 'free',
        stripe_subscription_id: null,
        plan_status: 'canceled',
      });
    } else if (event.type === 'invoice.payment_failed') {
      // Grace period: 3 days before downgrade (Task 1)
      const customerId = (event.data as Record<string, unknown>).customer as string;
      const gracePeriodEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      await db('organizations').where({ stripe_customer_id: customerId }).update({
        grace_period_ends_at: gracePeriodEndsAt,
      });
    } else if (event.type === 'invoice.paid') {
      // Payment succeeded — clear any active grace period
      const customerId = (event.data as Record<string, unknown>).customer as string;
      await db('organizations').where({ stripe_customer_id: customerId }).update({
        grace_period_ends_at: null,
      });
    }
  }

  private async resolveOrgId(event: StripeEvent): Promise<string> {
    const customerId = (event.data as Record<string, unknown>).customer as string | undefined;
    if (customerId) {
      const org = await this.deps.db('organizations').where({ stripe_customer_id: customerId }).first();
      if (org) return org.id as string;
    }
    return '00000000-0000-0000-0000-000000000000'; // fallback for unmatched events
  }
}

// --- GetBillingPortal ---
export class GetBillingPortal {
  constructor(private readonly deps: BillingDeps) {}

  async execute(orgId: string, returnUrl: string): Promise<string> {
    const { db, billingProvider } = this.deps;
    const org = await db('organizations').where({ id: orgId }).first();
    if (!org?.stripe_customer_id) throw new Error('NO_STRIPE_CUSTOMER');
    return billingProvider.createPortalSession(org.stripe_customer_id, returnUrl);
  }
}

// --- GetUsageSummary ---
export interface UsageSummary {
  plan: PlanName;
  limits: (typeof PLAN_LIMITS)[PlanName];
  usage: { annotations: number; projects: number; seats: number };
}

export class GetUsageSummary {
  constructor(private readonly deps: Pick<BillingDeps, 'db'>) {}

  async execute(orgId: string): Promise<UsageSummary> {
    const { db } = this.deps;
    const org = await db('organizations').where({ id: orgId }).first();
    if (!org) throw new Error('ORG_NOT_FOUND');

    const plan = (org.plan as PlanName) || 'free';
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

    const usageRow = await db('usage_records').where({ org_id: orgId, period_start: periodStart }).first();
    const annotations = usageRow?.annotations_count ?? 0;

    const [{ count: projectCount }] = await db('projects').where({ org_id: orgId }).count('id as count');
    const [{ count: seatCount }] = await db('memberships').where({ org_id: orgId }).count('id as count');

    return {
      plan,
      limits,
      usage: {
        annotations: Number(annotations),
        projects: Number(projectCount),
        seats: Number(seatCount),
      },
    };
  }
}

// --- CheckGracePeriods (Task 1) ---
export class CheckGracePeriods {
  constructor(private readonly deps: Pick<BillingDeps, 'db'>) {}

  async execute(): Promise<number> {
    const { db } = this.deps;
    const now = new Date();
    const expired = await db('organizations')
      .whereNotNull('grace_period_ends_at')
      .where('grace_period_ends_at', '<', now)
      .whereNot('plan', 'free');

    for (const org of expired) {
      await db('organizations').where({ id: org.id }).update({
        plan: 'free',
        plan_status: 'canceled',
        grace_period_ends_at: null,
      });
    }
    return expired.length;
  }
}
