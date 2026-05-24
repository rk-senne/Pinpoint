// SharedLink entity (Phase 1.5 / task 4.6.1).
//
// Public, optionally-password-protected handle for read-only access to a
// project. The lockout state machine (Req 15.3 – 15.6) is owned by the
// `verifyLinkPassword` use case; this type only models the persisted
// fields.

export interface SharedLink {
  id: string;
  projectId: string;
  /** bcrypt hash; null = no password (open link). */
  passwordHash?: string | null;
  createdAt: string;
  /** Set after MAX_FAILED_ATTEMPTS consecutive failures. */
  lockedUntil?: string | null;
  failedAttempts: number;
}

export interface NewSharedLink {
  projectId: string;
  passwordHash?: string | null;
}

export interface SharedLinkPatch {
  passwordHash?: string | null;
  failedAttempts?: number;
  lockedUntil?: string | null;
}
