import { Request, Response, NextFunction } from 'express';
import type { HelmetOptions } from 'helmet';

/**
 * Default CSP for API responses (OWASP CSP / ASVS V14.4): the API only emits
 * JSON, JS and images, so nothing may load, frame, submit or be based on
 * anything. Routes that legitimately return a document (the review-link
 * proxy, screenshots) overwrite this with their own, stricter-for-purpose
 * header AFTER this middleware ran.
 */
export const API_DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Feature policy: deny every powerful capability the product does not use. */
export const PERMISSIONS_POLICY = [
  'accelerometer', 'autoplay', 'bluetooth', 'browsing-topics', 'camera', 'display-capture', 'geolocation',
  'gyroscope', 'hid', 'interest-cohort', 'magnetometer', 'microphone', 'midi', 'payment', 'serial', 'usb', 'xr-spatial-tracking',
].map((f) => `${f}=()`).join(', ');

/**
 * helmet options. HSTS is sent only for a real HTTPS deployment (browsers
 * ignore it over http, and a COOKIE_INSECURE local stack is plain http):
 * 2 years + includeSubDomains + preload satisfies hstspreload.org.
 */
export function buildHelmetOptions(cookieInsecure: boolean): HelmetOptions {
  return {
    contentSecurityPolicy: false, // set per-response by securityHeaders / the document routes
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: cookieInsecure ? false : { maxAge: 63072000, includeSubDomains: true, preload: true },
  };
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('Content-Security-Policy', API_DEFAULT_CSP);
  res.setHeader('X-Request-Id', String(req.id ?? crypto.randomUUID()));
  next();
}
