/**
 * Port: BillingRepo — persistence abstraction for billing domain.
 *
 * Domain code depends on this interface instead of knex/pg directly,
 * keeping the hexagonal boundary intact.
 */

export interface BillingOrg {
  id: string;
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_status: string | null;
  grace_period_ends_at: Date | null;
}

export interface BillingRepo {
  findOrgById(orgId: string): Promise<BillingOrg | null>;
  findOrgByStripeCustomerId(customerId: string): Promise<BillingOrg | null>;
  updateOrg(orgId: string, patch: Partial<Omit<BillingOrg, 'id'>>): Promise<void>;
  updateOrgByStripeCustomerId(customerId: string, patch: Partial<Omit<BillingOrg, 'id'>>): Promise<void>;

  findSubscriptionEvent(stripeEventId: string): Promise<{ stripe_event_id: string } | null>;
  insertSubscriptionEvent(event: {
    org_id: string;
    stripe_event_id: string;
    event_type: string;
    data: string;
    processed_at: Date;
  }): Promise<void>;

  getUsage(orgId: string, periodStart: string): Promise<{ annotations_count: number } | null>;
  countProjects(orgId: string): Promise<number>;
  countSeats(orgId: string): Promise<number>;

  findOrgsWithExpiredGracePeriod(now: Date): Promise<BillingOrg[]>;
}
