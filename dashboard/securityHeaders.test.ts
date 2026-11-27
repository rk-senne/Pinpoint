import { describe, expect, it } from 'vitest';
import { DASHBOARD_CSP, buildDashboardCsp, dashboardSecurityHeaders, imageOrigins } from './vite.config';

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
    expect(d.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    // No wildcard / scheme-only sources anywhere (ZAP 10055 is accepted only for style-src 'unsafe-inline').
    for (const [name, values] of d) expect(values.filter((v) => v === '*' || /^[a-z]+:$/.test(v) && !['data:', 'blob:'].includes(v)), name).toEqual([]);
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

describe('configurable image origins', () => {
  it('adds only https origins (no paths, no credentials, no http) to img-src', () => {
    const env = {
      S3_PUBLIC_BASE_URL: 'https://cdn.example.com/screens/',
      S3_ENDPOINT: 'http://minio:9000',
      PINPOINT_IMG_ORIGINS: 'https://avatars.githubusercontent.com, https://u:p@evil.example, not a url,https://cdn.example.com',
    };
    expect(imageOrigins(env)).toEqual(['https://avatars.githubusercontent.com', 'https://cdn.example.com']);
    const img = directives(buildDashboardCsp(env)).get('img-src');
    expect(img).toEqual(["'self'", 'data:', 'blob:', 'https://avatars.githubusercontent.com', 'https://cdn.example.com']);
    expect(dashboardSecurityHeaders('/', env)['Content-Security-Policy']).toBe(buildDashboardCsp(env));
  });

  it('defaults to the strict policy', () => {
    expect(buildDashboardCsp({})).toBe(DASHBOARD_CSP);
  });
});
