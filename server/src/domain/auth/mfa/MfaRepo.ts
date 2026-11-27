// Outbound port for TOTP 2FA state (see migration 20261127120001_totp_mfa.ts).

export interface MfaRecord {
  userId: string;
  /** Plaintext base32 secret (the adapter encrypts/decrypts at rest). */
  secret: string;
  enabled: boolean;
  lastStep: number | null;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface MfaRepo {
  find(userId: string): Promise<MfaRecord | null>;
  /** Create or replace a PENDING (not yet enabled) enrollment. Never touches an enabled one. */
  upsertPending(userId: string, secret: string): Promise<boolean>;
  /** Turn a pending enrollment on and store the initial recovery-code hashes, atomically. */
  enable(userId: string, lastStep: number, recoveryHashes: string[]): Promise<boolean>;
  /** Delete the enrollment and every recovery code. */
  remove(userId: string): Promise<void>;
  /** Replace all recovery codes. */
  replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
  /** Mark a recovery code used. True only for the first caller (single use, race-safe). */
  consumeRecoveryCode(userId: string, hash: string): Promise<boolean>;
  /** Record a used time-step. True only when `step` is newer than the stored one (replay guard). */
  advanceStep(userId: string, step: number): Promise<boolean>;
  /** Atomically register a failed attempt; locks the account for `lockMs` once `max` is reached. */
  registerFailure(userId: string, max: number, lockMs: number, now: Date): Promise<void>;
  resetFailures(userId: string): Promise<void>;
}
