// Inbound HTTP adapter — TOTP two-factor management for the signed-in user.
//
// Mounted at `/api/v1/auth/mfa` behind the session/JWT middleware (API keys
// are NOT accepted: a leaked automation key must never be able to change 2FA).
//
//   GET    /                    → { enabled, recoveryCodesRemaining }
//   POST   /enroll              { password }         → { secret, otpauthUri }   (pending until verified)
//   POST   /verify              { code }             → { recoveryCodes }        (enables 2FA; codes shown once)
//   POST   /disable             { password, code }   → 204
//   POST   /recovery-codes      { password, code }   → { recoveryCodes }        (replaces the old set)
//
// `code` is a 6-digit TOTP or a recovery code. The login step-up lives in
// auth.routes.ts (`POST /login/mfa`).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { MfaService } from '../../../domain/auth/mfa/MfaService.js';
import { sendDomainError, sendZodFailure } from './errors.js';

export interface MfaRouteDeps {
  mfa: MfaService;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
}

const PasswordBody = z.object({ password: z.string().min(1).max(256) });
const CodeBody = z.object({ code: z.string().min(1).max(32) });
const PasswordCodeBody = PasswordBody.merge(CodeBody);

export function createMfaRoutes(deps: MfaRouteDeps): Router {
  const { mfa, authMiddleware } = deps;
  const router = Router();
  router.use((req, res, next) => {
    // Bearer API keys (pk_…) never manage 2FA.
    const h = req.headers.authorization;
    if (typeof h === 'string' && /^Bearer\s+pk_/i.test(h)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'API keys cannot manage two-factor authentication.' } });
      return;
    }
    next();
  });
  router.use(authMiddleware);
  // Responses carry secrets / recovery codes: never cacheable.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    res.json(await mfa.status(req.user!.userId));
  });

  router.post('/enroll', async (req, res) => {
    const p = PasswordBody.safeParse(req.body ?? {});
    if (!p.success) return void sendZodFailure(res, 'Invalid payload.', p.error.flatten());
    const r = await mfa.enroll(req.user!.userId, p.data.password);
    if (!r.ok) return void sendDomainError(res, r.error);
    res.status(200).json(r.value);
  });

  router.post('/verify', async (req, res) => {
    const p = CodeBody.safeParse(req.body ?? {});
    if (!p.success) return void sendZodFailure(res, 'Invalid payload.', p.error.flatten());
    const r = await mfa.confirm(req.user!.userId, p.data.code);
    if (!r.ok) return void sendDomainError(res, r.error);
    res.status(200).json(r.value);
  });

  router.post('/disable', async (req, res) => {
    const p = PasswordCodeBody.safeParse(req.body ?? {});
    if (!p.success) return void sendZodFailure(res, 'Invalid payload.', p.error.flatten());
    const r = await mfa.disable(req.user!.userId, p.data.password, p.data.code);
    if (!r.ok) return void sendDomainError(res, r.error);
    res.status(204).end();
  });

  router.post('/recovery-codes', async (req, res) => {
    const p = PasswordCodeBody.safeParse(req.body ?? {});
    if (!p.success) return void sendZodFailure(res, 'Invalid payload.', p.error.flatten());
    const r = await mfa.regenerateRecoveryCodes(req.user!.userId, p.data.password, p.data.code);
    if (!r.ok) return void sendDomainError(res, r.error);
    res.status(200).json(r.value);
  });

  return router;
}
