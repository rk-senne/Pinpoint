import { describe, expect, it } from 'vitest';
import { DASHBOARD_CSP, dashboardSecurityHeaders } from './vite.config';

const directives = (csp: string): Map<string, string[]> =>
  new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

describe('dashboard security headers', () => {
  it('CSP: first-party scripts only, no plugins, no framing, same-origin connections', () => {
    const d = directives(DASHBOARD_CSP);
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'self'"]);
    expect(d.get('form-action')).toEqual(["'self'"]);
    expect(d.get('connect-src')).toEqual(["'self'"]); // no ws:/wss: wildcard
    expect(d.get('img-src')).not.toContain('http:');
    expect(d.has('upgrade-insecure-requests')).toBe(true);
    expect(DASHBOARD_CSP).not.toMatch(/'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
  });

  it('app pages get CSP, XFO, COOP, CORP, Permissions-Policy, nosniff, Referrer-Policy', () => {
    const h = dashboardSecurityHeaders('/projects/123');
    expect(h['Content-Security-Policy']).toBe(DASHBOARD_CSP);
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Permissions-Policy']).toMatch(/camera=\(\)/);
    expect(h['Permissions-Policy']).toMatch(/microphone=\(\)/);
    expect(h['Permissions-Policy']).toMatch(/geolocation=\(\)/);
  });

  it('the proxied review frame keeps its own CSP and stays framable', () => {
    const h = dashboardSecurityHeaders('/review/abc123/frame');
    expect(h['Content-Security-Policy']).toBeUndefined();
    expect(h['X-Frame-Options']).toBeUndefined();
    expect(h['Cross-Origin-Opener-Policy']).toBeUndefined();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });
});
