// Privacy-specific domain errors. They reuse the generic kinds (so the HTTP
// layer maps them) and add a stable machine `code` plus `details` the
// dashboard can branch on.

import { Conflict, Forbidden } from '../shared/DomainError.js';

export class InvalidReauthentication extends Forbidden {
  constructor(message = 'Password confirmation failed.') {
    super(message);
    this.code = 'INVALID_PASSWORD';
  }
}

export class ConfirmationMismatch extends Conflict {
  readonly details?: Record<string, unknown>;
  constructor(message: string) {
    super(message);
    this.code = 'CONFIRMATION_MISMATCH';
  }
}

export class SoleOwnerBlocked extends Conflict {
  readonly details: Record<string, unknown>;
  constructor(orgs: Array<{ orgId: string; orgName: string; memberCount: number }>) {
    super(
      'You are the only owner of an organisation that still has other members. Transfer ownership to another member (or remove the other members) first.',
    );
    this.code = 'SOLE_OWNER';
    this.details = { orgs };
  }
}

export class ActiveSubscriptionBlocked extends Conflict {
  readonly details: Record<string, unknown>;
  constructor(orgs: Array<{ orgId: string; orgName: string }>) {
    super('Cancel the active subscription (Billing) before deleting the organisation or account.');
    this.code = 'ACTIVE_SUBSCRIPTION';
    this.details = { orgs };
  }
}
