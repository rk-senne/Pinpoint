// AuthToken entity (Phase 1.5 / task 4.6.1).
//
// Replaces the legacy `password_resets` table per Req 4 / 20. One row
// represents a single-use token issued for either email verification, a
// password reset, or a team invitation.

export type AuthTokenKind = 'verify_email' | 'reset_password' | 'team_invite';

export interface AuthToken {
  id: string;
  userId: string;
  kind: AuthTokenKind;
  /** SHA-256 hex digest of the raw token; the raw value is sent only via email. */
  tokenHash: string;
  expiresAt: string; // ISO 8601
  used: boolean;
  createdAt: string;
}

export interface NewAuthToken {
  userId: string;
  kind: AuthTokenKind;
  tokenHash: string;
  expiresAt: string;
}
