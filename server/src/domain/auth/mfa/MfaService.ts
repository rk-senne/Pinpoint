// TOTP two-factor authentication use cases (OWASP ASVS V2.8 / NIST SP 800-63B
// authenticator type "single-factor OTP device"). Pure domain code: crypto
// via node:crypto only, persistence through MfaRepo, time through Clock.
//
// Security properties:
//   * secret is 160 bits, encrypted at rest (adapter), shown exactly once at enrollment
//   * enrollment/disable/regeneration require the CURRENT PASSWORD (re-auth)
//   * a code is accepted at most once (time-step replay guard)
//   * brute force: 5 consecutive failures lock verification for 15 minutes per user
//     (DB-backed, so it holds across instances); a locked user is not even evaluated
//   * 10 single-use recovery codes, stored as SHA-256 only (≥50 bits of entropy each)
//   * the login step-up challenge is an HMAC-signed, 5-minute, purpose-bound token

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Conflict, Forbidden, Locked, NotFound, Unauthorized, Validation, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { PasswordHasher } from '../ports/PasswordHasher.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';
import type { MfaRepo } from './MfaRepo.js';
import { base32Encode, generateTotpSecret, otpauthUri, totpStep, verifyTotp } from './totp.js';

export const MFA_MAX_FAILURES = 5;
export const MFA_LOCK_MS = 15 * 60 * 1000;
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;

export interface MfaServiceDeps {
  mfaRepo: MfaRepo;
  userRepo: UserRepo;
  passwordHasher: PasswordHasher;
  clock: Clock;
  /** Key for the login challenge HMAC (the JWT secret; domain-separated below). */
  challengeSecret: string;
  issuer?: string;
}

export interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const normaliseRecovery = (s: string): string => s.toUpperCase().replace(/[^A-Z2-7]/g, '');

export function generateRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10); // 50 bits
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export class MfaService {
  constructor(private readonly deps: MfaServiceDeps) {}

  // ---- login challenge ---------------------------------------------------

  private challengeKey(): Buffer {
    return createHmac('sha256', 'pinpoint:mfa-challenge:v1').update(this.deps.challengeSecret).digest();
  }

  createChallenge(userId: string): string {
    const payload = Buffer.from(JSON.stringify({ u: userId, e: this.deps.clock.now().getTime() + MFA_CHALLENGE_TTL_MS, p: 'mfa' })).toString('base64url');
    const sig = createHmac('sha256', this.challengeKey()).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  /** Returns the user id for a valid, unexpired challenge, else null. */
  verifyChallenge(token: unknown): string | null {
    if (typeof token !== 'string' || token.length > 512) return null;
    const [payload, sig, extra] = token.split('.');
    if (!payload || !sig || extra !== undefined) return null;
    const expected = createHmac('sha256', this.challengeKey()).update(payload).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown; p?: unknown };
      if (body.p !== 'mfa' || typeof body.u !== 'string' || typeof body.e !== 'number') return null;
      return body.e > this.deps.clock.now().getTime() ? body.u : null;
    } catch {
      return null;
    }
  }

  // ---- queries -----------------------------------------------------------

  async isEnabled(userId: string): Promise<boolean> {
    return (await this.deps.mfaRepo.find(userId))?.enabled === true;
  }

  async status(userId: string): Promise<MfaStatus> {
    const rec = await this.deps.mfaRepo.find(userId);
    const enabled = rec?.enabled === true;
    return { enabled, recoveryCodesRemaining: enabled ? await this.deps.mfaRepo.countUnusedRecoveryCodes(userId) : 0 };
  }

  // ---- second-factor verification (login step-up + sensitive actions) ----

  /**
   * Check a TOTP code or a recovery code. Applies lockout, replay protection
   * and failure accounting. Generic failure message: never reveals which part
   * was wrong.
   */
  async verifySecondFactor(userId: string, rawCode: unknown): Promise<Result<{ method: 'totp' | 'recovery' }, DomainError>> {
    const { mfaRepo, clock } = this.deps;
    const rec = await mfaRepo.find(userId);
    if (!rec || !rec.enabled) return err(new Unauthorized('Invalid authentication code.', 'INVALID_MFA_CODE'));
    const now = clock.now();
    if (rec.lockedUntil && rec.lockedUntil.getTime() > now.getTime()) {
      return err(new Locked('Too many failed attempts. Try again later.', Math.ceil((rec.lockedUntil.getTime() - now.getTime()) / 1000)));
    }
    const code = typeof rawCode === 'string' ? rawCode.trim() : '';
    let method: 'totp' | 'recovery' | null = null;
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(rec.secret, code, now.getTime());
      if (step !== null && (await mfaRepo.advanceStep(userId, step))) method = 'totp';
    } else if (code.length > 0 && code.length <= 32) {
      const norm = normaliseRecovery(code);
      if (norm.length === 10 && (await mfaRepo.consumeRecoveryCode(userId, sha256(norm)))) method = 'recovery';
    }
    if (!method) {
      await mfaRepo.registerFailure(userId, MFA_MAX_FAILURES, MFA_LOCK_MS, now);
      return err(new Unauthorized('Invalid authentication code.', 'INVALID_MFA_CODE'));
    }
    await mfaRepo.resetFailures(userId);
    return ok({ method });
  }

  // ---- enrollment --------------------------------------------------------

  private async checkPassword(userId: string, password: unknown): Promise<DomainError | null> {
    const user = await this.deps.userRepo.findByIdWithSecret(userId);
    if (!user) return new NotFound('User not found.');
    if (typeof password !== 'string' || password.length === 0) return new Validation('Current password is required.');
    if (!user.passwordHash || !(await this.deps.passwordHasher.verify(password, user.passwordHash))) {
      return new Forbidden('Current password is incorrect.');
    }
    return null;
  }

  async enroll(userId: string, password: unknown): Promise<Result<{ secret: string; otpauthUri: string }, DomainError>> {
    const bad = await this.checkPassword(userId, password);
    if (bad) return err(bad);
    const user = await this.deps.userRepo.findById(userId);
    if (!user) return err(new NotFound('User not found.'));
    const secret = generateTotpSecret();
    if (!(await this.deps.mfaRepo.upsertPending(userId, secret))) {
      return err(new Conflict('Two-factor authentication is already enabled.'));
    }
    return ok({ secret, otpauthUri: otpauthUri({ secret, account: user.email, issuer: this.deps.issuer ?? 'Pinpoint' }) });
  }

  /** Confirm enrollment with the first code from the authenticator; returns the recovery codes ONCE. */
  async confirm(userId: string, rawCode: unknown): Promise<Result<{ recoveryCodes: string[] }, DomainError>> {
    const { mfaRepo, clock } = this.deps;
    const rec = await mfaRepo.find(userId);
    if (!rec) return err(new Conflict('Start enrollment first.'));
    if (rec.enabled) return err(new Conflict('Two-factor authentication is already enabled.'));
    const now = clock.now();
    if (rec.lockedUntil && rec.lockedUntil.getTime() > now.getTime()) {
      return err(new Locked('Too many failed attempts. Try again later.', Math.ceil((rec.lockedUntil.getTime() - now.getTime()) / 1000)));
    }
    const code = typeof rawCode === 'string' ? rawCode.trim() : '';
    const step = verifyTotp(rec.secret, code, now.getTime());
    if (step === null) {
      await mfaRepo.registerFailure(userId, MFA_MAX_FAILURES, MFA_LOCK_MS, now);
      return err(new Validation('That code is not valid. Check the time on your device and try again.'));
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    if (!(await mfaRepo.enable(userId, step, codes.map((c) => sha256(normaliseRecovery(c)))))) {
      return err(new Conflict('Two-factor authentication is already enabled.'));
    }
    return ok({ recoveryCodes: codes });
  }

  /** Password + a valid second factor (TOTP or recovery) required. */
  private async reauth(userId: string, password: unknown, code: unknown): Promise<DomainError | null> {
    const bad = await this.checkPassword(userId, password);
    if (bad) return bad;
    const second = await this.verifySecondFactor(userId, code);
    return second.ok ? null : second.error;
  }

  async disable(userId: string, password: unknown, code: unknown): Promise<Result<true, DomainError>> {
    if (!(await this.isEnabled(userId))) return err(new Conflict('Two-factor authentication is not enabled.'));
    const bad = await this.reauth(userId, password, code);
    if (bad) return err(bad);
    await this.deps.mfaRepo.remove(userId);
    return ok(true);
  }

  async regenerateRecoveryCodes(userId: string, password: unknown, code: unknown): Promise<Result<{ recoveryCodes: string[] }, DomainError>> {
    if (!(await this.isEnabled(userId))) return err(new Conflict('Two-factor authentication is not enabled.'));
    const bad = await this.reauth(userId, password, code);
    if (bad) return err(bad);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await this.deps.mfaRepo.replaceRecoveryCodes(userId, codes.map((c) => sha256(normaliseRecovery(c))));
    return ok({ recoveryCodes: codes });
  }
}

export { totpStep };
