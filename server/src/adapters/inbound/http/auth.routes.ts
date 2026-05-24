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

import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { Login } from '../../../domain/auth/usecases/login.js';
import type { RegisterUser } from '../../../domain/auth/usecases/registerUser.js';
import type { RefreshToken } from '../../../domain/auth/usecases/refreshToken.js';
import type { VerifyEmail } from '../../../domain/auth/usecases/verifyEmail.js';
import type { RequestPasswordReset } from '../../../domain/auth/usecases/requestPasswordReset.js';
import type { CompletePasswordReset } from '../../../domain/auth/usecases/completePasswordReset.js';
import type { Logout } from '../../../domain/auth/usecases/logout.js';
import { sendDomainError, sendZodFailure, paramString } from './errors.js';

export interface AuthRouteDeps {
  login: Login;
  registerUser: RegisterUser;
  refreshToken: RefreshToken;
  verifyEmail: VerifyEmail;
  requestPasswordReset: RequestPasswordReset;
  completePasswordReset: CompletePasswordReset;
  logout: Logout;
  /**
   * Whether to omit the `Secure` cookie attribute. The legacy route
   * skipped Secure when `NODE_ENV === 'test'` so the supertest
   * transport (plain HTTP) could read the cookie back. The composition
   * root passes `process.env.NODE_ENV === 'test'` here.
   */
  cookieInsecure?: boolean;
}

// --- Zod schemas (re-used by handlers) ------------------------------------

const RegisterBodySchema = z.object({
  email: z.string().min(1, 'Email is required.'),
  password: z.string().min(1, 'Password is required.'),
  name: z.string().min(1, 'Name is required.'),
});

const LoginBodySchema = z.object({
  email: z.string().min(1, 'Email is required.'),
  password: z.string().min(1, 'Password is required.'),
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

function buildSessionCookie(token: string, insecure: boolean): string {
  const parts = [`fl_session=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (!insecure) parts.splice(2, 0, 'Secure');
  return parts.join('; ');
}

function buildCsrfCookie(csrf: string): string {
  return [`fl_csrf=${csrf}`, 'SameSite=Lax', 'Path=/'].join('; ');
}

function buildClearCookies(): string[] {
  // Issue both cookies with `Max-Age=0` so the browser deletes them.
  return [
    'fl_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    'fl_csrf=; SameSite=Lax; Path=/; Max-Age=0',
  ];
}

// --- Router factory --------------------------------------------------------

export function createAuthRoutes(deps: AuthRouteDeps): Router {
  const {
    login,
    registerUser,
    refreshToken,
    verifyEmail,
    requestPasswordReset,
    completePasswordReset,
    logout,
    cookieInsecure = false,
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
    const result = await login.execute(parsed.data);
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    const { user, token, csrfToken } = result.value;
    res.setHeader('Set-Cookie', [
      buildSessionCookie(token, cookieInsecure),
      buildCsrfCookie(csrfToken),
    ]);
    res.status(200).json({ user, token, csrfToken });
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
  // No-op semantics: always returns 200 with the generic message so the
  // endpoint cannot be used to enumerate accounts. Behaviour is identical
  // to `requestPasswordReset` from the caller's perspective — request a
  // fresh email if the address is registered, otherwise nothing visible
  // happens. The legacy implementation also drove the verify-email path
  // through `RegisterUser`, but the hex use case set is intentionally
  // narrower for now: this handler validates input and returns the
  // generic message; reissuing the token will land alongside future
  // notification work.
  router.post('/resend-verification', async (req: Request, res: Response) => {
    const parsed = ResendVerificationBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid resend-verification payload.', parsed.error.flatten());
      return;
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
    const cookieToken =
      typeof req.cookies?.fl_session === 'string' && req.cookies.fl_session.length > 0
        ? (req.cookies.fl_session as string)
        : null;
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
      const csrfToken = randomBytes(32).toString('hex');
      res.setHeader('Set-Cookie', [
        buildSessionCookie(fresh, cookieInsecure),
        buildCsrfCookie(csrfToken),
      ]);
      res.status(200).json({ token: fresh, csrfToken });
      return;
    }

    res.status(200).json({ token: fresh });
  });

  // POST /logout ---------------------------------------------------------
  router.post('/logout', async (req: Request, res: Response) => {
    const userId = typeof req.user?.userId === 'string' ? req.user.userId : null;
    const result = await logout.execute({ userId });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.setHeader('Set-Cookie', buildClearCookies());
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
