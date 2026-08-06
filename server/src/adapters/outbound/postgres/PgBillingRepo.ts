import type { Knex } from 'knex';
import type { BillingOrg, BillingRepo } from '../../../domain/billing/ports/BillingRepo.js';

export class PgBillingRepo implements BillingRepo {
  constructor(private readonly db: Knex) {}

  async findOrgById(orgId: string): Promise<BillingOrg | null> {
    const row = await this.db('organizations').where({ id: orgId }).first();
    if (!row) return null;
    return this.toOrg(row);
  }

  async findOrgByStripeCustomerId(customerId: string): Promise<BillingOrg | null> {
    const row = await this.db('organizations').where({ stripe_customer_id: customerId }).first();
    if (!row) return null;
    return this.toOrg(row);
  }

  async updateOrg(orgId: string, patch: Partial<Omit<BillingOrg, 'id'>>): Promise<void> {
    await this.db('organizations').where({ id: orgId }).update(patch);
  }

  async updateOrgByStripeCustomerId(customerId: string, patch: Partial<Omit<BillingOrg, 'id'>>): Promise<void> {
    await this.db('organizations').where({ stripe_customer_id: customerId }).update(patch);
  }

  async findSubscriptionEvent(stripeEventId: string): Promise<{ stripe_event_id: string } | null> {
    const row = await this.db('subscription_events').where({ stripe_event_id: stripeEventId }).first();
    if (!row) return null;
    return { stripe_event_id: row.stripe_event_id };
  }

  async insertSubscriptionEvent(event: {
    org_id: string;
    stripe_event_id: string;
    event_type: string;
    data: string;
    processed_at: Date;
  }): Promise<void> {
    await this.db('subscription_events').insert(event);
  }

  async getUsage(orgId: string, periodStart: string): Promise<{ annotations_count: number } | null> {
    const row = await this.db('usage_records').where({ org_id: orgId, period_start: periodStart }).first();
    if (!row) return null;
    return { annotations_count: row.annotations_count };
  }

  async countProjects(orgId: string): Promise<number> {
    const [{ count }] = await this.db('projects').where({ org_id: orgId }).count('id as count');
    return Number(count);
  }

  async countSeats(orgId: string): Promise<number> {
    const [{ count }] = await this.db('memberships').where({ org_id: orgId }).count('id as count');
    return Number(count);
  }

  async findOrgsWithExpiredGracePeriod(now: Date): Promise<BillingOrg[]> {
    const rows = await this.db('organizations')
      .whereNotNull('grace_period_ends_at')
      .where('grace_period_ends_at', '<', now)
      .whereNot('plan', 'free');
    return rows.map((row: Record<string, unknown>) => this.toOrg(row));
  }

  private toOrg(row: Record<string, unknown>): BillingOrg {
    return {
      id: row.id as string,
      plan: row.plan as string,
      stripe_customer_id: (row.stripe_customer_id as string) ?? null,
      stripe_subscription_id: (row.stripe_subscription_id as string) ?? null,
      plan_status: (row.plan_status as string) ?? null,
      grace_period_ends_at: row.grace_period_ends_at ? new Date(row.grace_period_ends_at as string) : null,
    };
  }
}
