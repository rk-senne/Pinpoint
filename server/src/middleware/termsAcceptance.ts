// Registration terms acceptance (GDPR Art. 7(1) record of acceptance / POPIA s.11).
//
// Mounted in front of the auth router for `POST /api/v1/auth/register` only:
//
//   * the request must carry `acceptTerms: true` (the dashboard's required
//     "I agree to the Terms and Privacy Policy" checkbox) or it is rejected 400
//     `TERMS_NOT_ACCEPTED` before any account is created;
//   * when the register use case answers 201 the new user's id is read from the
//     response body and `users.accepted_terms_at` / `users.terms_version` are
//     stamped BEFORE the response is released. A duplicate-e-mail registration
//     returns a decoy id that matches no row, so it stamps nothing (and still
//     reveals nothing — F-17).
//
// It wraps the response instead of editing the register use case so the
// feature stays in one self-contained, separately tested file.

import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';

import { TERMS_VERSION } from '../domain/privacy/termsVersion.js';
import { runAsSystem } from '../infrastructure/tenantContext.js';

export interface TermsAcceptanceOptions {
  db: Knex;
  /** Reject registrations lacking `acceptTerms: true`. Default true. */
  required?: boolean;
  now?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTermsAcceptance(opts: TermsAcceptanceOptions) {
  const required = opts.required ?? true;
  const now = opts.now ?? (() => new Date());

  return function termsAcceptance(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'POST' || req.path.replace(/\/+$/, '') !== '/register') {
      next();
      return;
    }
    const accepted = (req.body as { acceptTerms?: unknown } | undefined)?.acceptTerms === true;
    if (!accepted && required) {
      res.status(400).json({
        error: {
          code: 'TERMS_NOT_ACCEPTED',
          message: 'You must accept the Terms of Service and Privacy Policy to create an account.',
        },
      });
      return;
    }
    if (!accepted) {
      next();
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const id = (body as { user?: { id?: unknown } } | undefined)?.user?.id;
      if (res.statusCode === 201 && typeof id === 'string' && UUID_RE.test(id)) {
        runAsSystem(() =>
          opts
            .db('users')
            .where({ id })
            .whereNull('accepted_terms_at')
            .update({ accepted_terms_at: now(), terms_version: TERMS_VERSION }),
        )
          .catch(() => undefined) // never fail a registration over the stamp; the use case already committed
          .finally(() => originalJson(body));
        return res;
      }
      return originalJson(body);
    }) as Response['json'];
    next();
  };
}
