/**
 * Sentry error tracking integration.
 *
 * Enable by setting the SENTRY_DSN environment variable.
 * This module is imported early in the server entry point.
 */

let Sentry: any = null;

export function initSentry(dsn: string | undefined, environment: string): void {
  if (!dsn) return;

  try {
    // Dynamic import to avoid hard dependency — `@sentry/node` must be installed
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment,
      tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
      integrations: [
        Sentry.httpIntegration(),
        Sentry.expressIntegration(),
      ],
    });
  } catch {
    // @sentry/node not installed — skip silently
  }
}

export function getSentry(): any | null {
  return Sentry;
}

export function captureException(err: unknown): void {
  if (Sentry) Sentry.captureException(err);
}
