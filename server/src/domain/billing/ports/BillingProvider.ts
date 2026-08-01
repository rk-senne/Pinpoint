/**
 * Port: BillingProvider — abstracts Stripe (or any payment processor).
 */
export interface StripeEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface BillingProvider {
  createCustomer(orgId: string, email: string, name: string): Promise<string>;
  createCheckoutSession(customerId: string, priceId: string, successUrl: string, cancelUrl: string): Promise<string>;
  createPortalSession(customerId: string, returnUrl: string): Promise<string>;
  constructWebhookEvent(body: string, signature: string): Promise<StripeEvent>;
}
