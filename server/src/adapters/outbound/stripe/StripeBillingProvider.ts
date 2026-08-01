/**
 * Outbound adapter: Stripe billing provider.
 *
 * Accepts a pre-constructed Stripe instance typed as `any` to avoid
 * compile errors when the `stripe` npm package isn't installed yet.
 * Once installed: `npm install stripe`
 */
import type { BillingProvider, StripeEvent } from '../../../domain/billing/ports/BillingProvider.js';

export class StripeBillingProvider implements BillingProvider {
  constructor(
    private readonly stripe: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    private readonly webhookSecret: string,
  ) {}

  async createCustomer(orgId: string, email: string, name: string): Promise<string> {
    const customer = await this.stripe.customers.create({
      email,
      name,
      metadata: { orgId },
    });
    return customer.id as string;
  }

  async createCheckoutSession(customerId: string, priceId: string, successUrl: string, cancelUrl: string): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return session.url as string;
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return session.url as string;
  }

  async constructWebhookEvent(body: string, signature: string): Promise<StripeEvent> {
    const event = this.stripe.webhooks.constructEvent(body, signature, this.webhookSecret);
    return {
      id: event.id,
      type: event.type,
      data: event.data.object,
    };
  }
}
