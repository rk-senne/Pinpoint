// Inbound HTTP adapter — auth routes (Phase 1.5 / task 4.9.1).
//
// Thin Express handlers that translate HTTP requests into Use_Case
// invocations. No business logic lives here:
//   - Pull input from req (body, params, cookies, headers).
//   - Validate via Zod where appropriate.
//   - Call exactly one Use_Case from the injected dependency record.
//   - Map `Result.ok` → the legacy 2xx response shape; `Result.err`
//     → `sendDomainError` for the HTTP status mapping.
//
// The factory exports `createAuthRoutes(deps)`. Composition root
// (task 4.10) constructs the concrete `Login`, `RegisterUser`, … use
// cases and supplies them here.

import { Router, type Request, type Response , type NextFunction} from 'express';
import {
  buildClearCookies,
  buildCsrfCookie,
  buildSessionCookie,
  readSessionCookie,
  type CsrfBinder,
} from '../../../middleware/sessionCookies.js';
import { z } from 'zod';

import type { Login } from '../../../domain/auth/usecases/login.js';
import type { RegisterUser } from '../../../domain/auth/usecases/registerUser.js';
import type { RefreshToken } from '../../../domain/auth/usecases/refreshToken.js';
import type { VerifyEmail } from '../../../domain/auth/usecases/verifyEmail.js';
import type { RequestPasswordReset } from '../../../domain/auth/usecases/requestPasswordReset.js';
import type { CompletePasswordReset } from '../../../domain/auth/usecases/completePasswordReset.js';
import type { ResendVerification } from '../../../domain/auth/usecases/resendVerification.js';
import type { Logout } from '../../../domain/auth/usecases/logout.js';
import type { MfaService } from '../../../domain/auth/mfa/MfaService.js';
import { Unauthorized } from '../../../domain/shared/DomainError.js';
import { sendDomainError, sendZodFailure, paramString } from './errors.js';

export interface AuthRouteDeps {
  login: Login;
  registerUser: RegisterUser;
  refreshToken: RefreshToken;
  verifyEmail: VerifyEmail;
  requestPasswordReset: RequestPasswordReset;
  completePasswordReset: CompletePasswordReset;
  /** Re-issues the verify_email token + email; omitted → endpoint is a pure no-op. */
  resendVerification?: ResendVerification;
  logout: Logout;
  /**
   * Populates req.user when a valid session/bearer is present (never 401s).
   * Lets /logout bump the caller's token_version so every outstanding JWT
   * for that user is revoked, not just the cookie on this browser.
   */
  optionalAuth?: (req: Request, res: Response, next: NextFunction) => void;
  /**
   * Whether to omit the `Secure` cookie attribute. The legacy route
   * skipped Secure when `NODE_ENV === 'test'` so the supertest
   * transport (plain HTTP) could read the cookie back. The composition
   * root passes `process.env.NODE_ENV === 'test'` here.
   */
  cookieInsecure?: boolean;
  /** TOTP step-up (`POST /login/mfa`). When absent the endpoint answers 404 and accounts never get a challenge. */
  mfa?: MfaService;
  /** PP-15: binds the CSRF token to the issued session. Without it a random nonce is used. */
  csrfBinder?: CsrfBinder;
}

// --- Zod schemas (re-used by handlers) ------------------------------------

const RegisterBodySchema = z.object({
  // PP-12: a malformed address would create an unverifiable row + a queued mail.
  email: z.string().trim().min(1, 'Email is required.').max(254).email('Email address is not valid.'),
  password: z.string().min(1, 'Password is required.').max(256),
  name: z.string().trim().min(1, 'Name is required.').max(100),
});

const LoginBodySchema = z.object({
  email: z.string().min(1, 'Email is required.').max(254),
  password: z.string().min(1, 'Password is required.').max(256),
});

const LoginMfaBodySchema = z.object({
  mfaToken: z.string().min(1).max(512),
  // 6-digit TOTP or an XXXXX-XXXXX recovery code.
  code: z.string().min(1).max(32),
});

const ResetRequestBodySchema = z.object({
  email: z.string().min(1, 'Email is required.'),
});

const ResetCompleteBodySchema = z.object({
  password: z.string().min(1, 'New password is required.'),
});

const ResendVerificationBodySchema = z.object({
  email: z.string().min(1, 'Email is required.'),
});

// --- Cookie helpers --------------------------------------------------------

// --- Router factory --------------------------------------------------------

export function createAuthRoutes(deps: AuthRouteDeps): Router {
  const optionalAuth = deps.optionalAuth ?? ((_req: Request, _res: Response, next: NextFunction) => next());
  const {
    login,
    registerUser,
    refreshToken,
    verifyEmail,
    requestPasswordReset,
    completePasswordReset,
    resendVerification,
    logout,
    cookieInsecure = false,
    csrfBinder,
  } = deps;

  const router = Router();

  // POST /register --------------------------------------------------------
  router.post('/register', async (req: Request, res: Response) => {
    const parsed = RegisterBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid registration payload.', parsed.error.flatten());
      return;
    }
    const result = await registerUser.execute(parsed.data);
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(201).json({ user: result.value.user });
  });

  // POST /login -----------------------------------------------------------
  router.post('/login', async (req: Request, res: Response) => {
    const parsed = LoginBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid login payload.', parsed.error.flatten());
      return;
    }
    const result = await login.begin(parsed.data);
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    if ('mfaRequired' in result.value) {
      // Password was correct but a second factor is required: no cookies, no user.
      res.status(200).json({ mfaRequired: true, mfaToken: result.value.mfaToken });
      return;
    }
    const { user, token } = result.value;
    const csrfToken = csrfBinder ? csrfBinder.mintForToken(token) : result.value.csrfToken;
    res.setHeader('Set-Cookie', [
      buildSessionCookie(token, cookieInsecure),
      buildCsrfCookie(csrfToken, cookieInsecure),
    ]);
    res.status(200).json({ user, token, csrfToken });
  });

  // POST /login/mfa -------------------------------------------------------
  // Step two for accounts with TOTP enabled. The challenge from /login proves
  // the password step; the code (TOTP or recovery) proves the second factor.
  router.post('/login/mfa', async (req: Request, res: Response) => {
    if (!deps.mfa) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
      return;
    }
    const parsed = LoginMfaBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid login payload.', parsed.error.flatten());
      return;
    }
    const userId = deps.mfa.verifyChallenge(parsed.data.mfaToken);
    if (!userId) {
      sendDomainError(res, new Unauthorized('The sign-in session expired. Sign in again.', 'MFA_CHALLENGE_INVALID'));
      return;
    }
    (req as Request & { auditActorId?: string }).auditActorId = userId;
    const second = await deps.mfa.verifySecondFactor(userId, parsed.data.code);
    if (!second.ok) {
      sendDomainError(res, second.error);
      return;
    }
    const result = await login.completeMfa(userId);
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const { user, token } = result.value;
    const csrfToken = csrfBinder ? csrfBinder.mintForToken(token) : result.value.csrfToken;
    res.setHeader('Set-Cookie', [
      buildSessionCookie(token, cookieInsecure),
      buildCsrfCookie(csrfToken, cookieInsecure),
    ]);
    res.status(200).json({ user, token, csrfToken, mfaMethod: second.value.method });
  });

  // POST /verify-email/:token --------------------------------------------
  router.post('/verify-email/:token', async (req: Request, res: Response) => {
    const token = paramString(req.params.token);
    const result = await verifyEmail.execute({ token });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ verified: true });
  });

  // POST /resend-verification --------------------------------------------
  // For an unverified account this voids older verify tokens, mints a fresh
  // one and enqueues the email through the durable queue. The response is
  // IDENTICAL for known, unknown, already-verified and failing inputs so the
  // endpoint cannot enumerate accounts (F-17).
  router.post('/resend-verification', async (req: Request, res: Response) => {
    const parsed = ResendVerificationBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid resend-verification payload.', parsed.error.flatten());
      return;
    }
    if (resendVerification) {
      try {
        await resendVerification.execute({ email: parsed.data.email });
      } catch {
        // Swallow: a failure must look the same as success (no oracle).
      }
    }
    res.status(200).json({
      message: 'If this email is registered, a verification link has been sent.',
    });
  });

  // POST /refresh ---------------------------------------------------------
  router.post('/refresh', async (req: Request, res: Response) => {
    let bearerToken: string | null = null;
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const value = header.slice(7).trim();
      if (value.length > 0) bearerToken = value;
    }
    const cookieToken = readSessionCookie(req.cookies);
    const usedCookie = bearerToken === null && cookieToken !== null;
    const token = bearerToken ?? cookieToken ?? '';

    const result = await refreshToken.execute({ token });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const fresh = result.value.token;

    if (usedCookie) {
      // Slide both cookies forward when the request used cookie auth.
      // Use a fresh CSRF nonce for the session refresh; the use case's
      // own value is fine but we re-issue here to keep the cookie pair
      // and body in sync without trusting the client's stale token.
      const csrfToken = csrfBinder ? csrfBinder.mintForToken(fresh) : result.value.csrfToken;
      res.setHeader('Set-Cookie', [
        buildSessionCookie(fresh, cookieInsecure),
        buildCsrfCookie(csrfToken, cookieInsecure),
      ]);
      res.status(200).json({ token: fresh, csrfToken });
      return;
    }

    res.status(200).json({ token: fresh });
  });

  // POST /logout ---------------------------------------------------------
  router.post('/logout', optionalAuth, async (req: Request, res: Response) => {
    const userId = typeof req.user?.userId === 'string' ? req.user.userId : null;
    const result = await logout.execute({ userId });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.setHeader('Set-Cookie', buildClearCookies(cookieInsecure));
    res.status(200).json({ success: true });
  });

  // POST /reset-password (request) ---------------------------------------
  router.post('/reset-password', async (req: Request, res: Response) => {
    const parsed = ResetRequestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid reset-password payload.', parsed.error.flatten());
      return;
    }
    const result = await requestPasswordReset.execute({ email: parsed.data.email });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    // Always return the generic message regardless of whether the email
    // matched. The use case enforces this property in code.
    res.status(200).json({
      message: 'If an account with that email exists, a reset link has been sent.',
    });
  });

  // POST /reset-password/:token (complete) -------------------------------
  router.post('/reset-password/:token', async (req: Request, res: Response) => {
    const parsed = ResetCompleteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid reset-password payload.', parsed.error.flatten());
      return;
    }
    const result = await completePasswordReset.execute({
      token: paramString(req.params.token),
      newPassword: parsed.data.password,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ message: 'Password has been reset successfully.' });
  });

  return router;
}
