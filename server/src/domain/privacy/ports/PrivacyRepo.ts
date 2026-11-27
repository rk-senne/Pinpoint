// PrivacyRepo port — persistence needed by the data-subject-rights use cases
// (export, account erasure, organisation erasure). The Postgres adapter runs
// user-spanning work in the trusted system tenant context, scoped strictly by
// the requesting user id; org-scoped work runs in the request's org context.

import type { ArchiveWriter } from './ArchiveWriter.js';

export interface UserMembershipSummary {
  orgId: string;
  orgName: string;
  role: string;
  /** Members of the org (including this user). */
  memberCount: number;
  /** Owners of the org (including this user when they are one). */
  ownerCount: number;
  /** True when Stripe billing is attached and not cancelled. */
  hasActiveSubscription: boolean;
}

export interface OrgSummary {
  id: string;
  name: string;
  hasActiveSubscription: boolean;
}

export interface UserAuthRecord {
  email: string;
  passwordHash: string | null;
}

export interface AccountErasureOutcome {
  /** Orgs that had no other member and were deleted with the account. */
  orgsDeleted: string[];
  /** Orgs the user left (their content was anonymised, org kept). */
  orgsLeft: string[];
  /** Screenshot object keys of the deleted orgs (to be removed after commit). */
  screenshotKeys: string[];
}

export interface OrgErasureOutcome {
  screenshotKeys: string[];
}

export interface PrivacyRepo {
  getUserAuth(userId: string): Promise<UserAuthRecord | null>;
  getUserMemberships(userId: string): Promise<UserMembershipSummary[]>;
  getOrg(orgId: string): Promise<OrgSummary | null>;

  /** Stream everything held about `userId` (across orgs) into the archive. */
  streamUserExport(userId: string, writer: ArchiveWriter): Promise<void>;
  /** Stream the org's data into the archive. Runs in the caller's org tenant context. */
  streamOrgExport(orgId: string, writer: ArchiveWriter): Promise<void>;

  /**
   * Erase the account in ONE transaction: re-assign owned projects/teams,
   * anonymise authored content, delete personal rows, scrub audit events,
   * delete the user, and write a PII-free `privacy.account_deleted` audit row.
   * Throws {@link SoleOwnerError}-style conflicts as `Conflict` via the
   * use case; the repo re-checks inside the transaction and returns
   * `{ blockedOrgs }` instead of deleting when the precondition no longer holds.
   */
  eraseAccount(userId: string): Promise<AccountErasureOutcome | { blockedOrgs: string[] }>;

  /** Delete the org and everything it owns in ONE transaction; audit row survives. */
  eraseOrg(orgId: string, actorId: string): Promise<OrgErasureOutcome>;
}
